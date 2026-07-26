import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BuzzCliClient, BuzzCliError } from "../src/buzz/BuzzCliClient.js";

/**
 * buzz-cli's command surface is an API contract Cyrus does not control. These
 * tests pin both halves of it:
 *
 * - The **shape** we send (argv, stdin, environment) and parse (stdout JSON,
 *   stderr error envelope, exit codes) is pinned against a stub binary, so it
 *   runs everywhere.
 * - The **real** binary, when present, is checked for the flags we depend on,
 *   so an upstream rename fails here rather than at the first agent reply.
 *   Point `BUZZ_CLI_PATH` at the binary to enable it (the buzz-cli crate builds
 *   a binary named `buzz`, not `buzz-cli`).
 */

let dir: string;
let stubPath: string;
let argsFile: string;

/**
 * A stand-in for the `buzz` binary: records its argv, stdin and the parts of
 * the environment we care about, then replays a canned response.
 */
const STUB = `#!/usr/bin/env node
const { writeFileSync, readFileSync } = require("node:fs");
let stdin = "";
try { stdin = readFileSync(0, "utf8"); } catch {}
writeFileSync(process.env.BUZZ_STUB_ARGS_FILE, JSON.stringify({
  args: process.argv.slice(2),
  stdin,
  env: {
    BUZZ_RELAY_URL: process.env.BUZZ_RELAY_URL,
    BUZZ_PRIVATE_KEY: process.env.BUZZ_PRIVATE_KEY,
    BUZZ_AUTH_TAG: process.env.BUZZ_AUTH_TAG ?? null,
  },
}));
if (process.env.BUZZ_STUB_STDERR) process.stderr.write(process.env.BUZZ_STUB_STDERR);
if (process.env.BUZZ_STUB_STDOUT) process.stdout.write(process.env.BUZZ_STUB_STDOUT);
process.exit(Number(process.env.BUZZ_STUB_EXIT ?? "0"));
`;

function client(): BuzzCliClient {
	return new BuzzCliClient({
		binaryPath: stubPath,
		relayUrl: "https://relay.example.com",
		privateKey: "nsec-test",
		timeoutMs: 10_000,
	});
}

function recorded(): {
	args: string[];
	stdin: string;
	env: Record<string, string | null>;
} {
	return JSON.parse(readFileSync(argsFile, "utf8"));
}

describe("BuzzCliClient against a stub binary", () => {
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "buzz-cli-test-"));
		stubPath = join(dir, "buzz");
		argsFile = join(dir, "args.json");
		writeFileSync(stubPath, STUB);
		chmodSync(stubPath, 0o755);

		process.env.BUZZ_STUB_ARGS_FILE = argsFile;
		process.env.BUZZ_STUB_STDOUT = JSON.stringify({
			event_id: "f".repeat(64),
			accepted: true,
			message: "",
		});
		delete process.env.BUZZ_STUB_STDERR;
		delete process.env.BUZZ_STUB_EXIT;
	});

	afterEach(() => {
		for (const key of [
			"BUZZ_STUB_ARGS_FILE",
			"BUZZ_STUB_STDOUT",
			"BUZZ_STUB_STDERR",
			"BUZZ_STUB_EXIT",
		]) {
			delete process.env[key];
		}
	});

	it("sends a threaded reply with the body on stdin", async () => {
		const eventId = await client().sendMessage({
			channelId: "chan-1",
			content: 'a "quoted"\nmultiline body',
			replyTo: "a".repeat(64),
		});

		expect(eventId).toBe("f".repeat(64));

		const call = recorded();
		expect(call.args).toEqual([
			"messages",
			"send",
			"--channel",
			"chan-1",
			"--content",
			"-",
			"--reply-to",
			"a".repeat(64),
		]);
		// The body travels on stdin, never on argv: newlines and quotes would be
		// mangled by the shell, and message text would leak into `ps`.
		expect(call.stdin).toBe('a "quoted"\nmultiline body');
	});

	it("omits --reply-to for a top-level message", async () => {
		await client().sendMessage({ channelId: "chan-1", content: "hi" });

		expect(recorded().args).not.toContain("--reply-to");
	});

	it("passes credentials through the environment, not argv", async () => {
		await client().sendMessage({ channelId: "chan-1", content: "hi" });

		const call = recorded();
		expect(call.env.BUZZ_RELAY_URL).toBe("https://relay.example.com");
		expect(call.env.BUZZ_PRIVATE_KEY).toBe("nsec-test");
		expect(call.args.join(" ")).not.toContain("nsec-test");
	});

	it("builds the documented reactions command", async () => {
		process.env.BUZZ_STUB_STDOUT = "{}";
		await client().addReaction({ eventId: "b".repeat(64), emoji: "▶️" });

		expect(recorded().args).toEqual([
			"reactions",
			"add",
			"--event",
			"b".repeat(64),
			"--emoji",
			"▶️",
		]);
	});

	it("reads a single event out of the thread query", async () => {
		const target = "c".repeat(64);
		process.env.BUZZ_STUB_STDOUT = JSON.stringify([
			{
				id: "d".repeat(64),
				pubkey: "1",
				kind: 9,
				content: "reply",
				created_at: 2,
				tags: [],
			},
			{
				id: target,
				pubkey: "2",
				kind: 9,
				content: "root",
				created_at: 1,
				tags: [],
			},
		]);

		const found = await client().getEvent({
			channelId: "chan-1",
			eventId: target,
		});

		expect(found?.content).toBe("root");
		expect(recorded().args).toEqual([
			"messages",
			"thread",
			"--channel",
			"chan-1",
			"--event",
			target,
		]);
	});

	it("returns null when the relay does not have the event", async () => {
		process.env.BUZZ_STUB_STDOUT = "[]";

		await expect(
			client().getEvent({ channelId: "chan-1", eventId: "c".repeat(64) }),
		).resolves.toBeNull();
	});

	// buzz-cli reports failures as {"error","message","retryable"} on stderr.
	it("surfaces the CLI's own error category and retryability", async () => {
		process.env.BUZZ_STUB_EXIT = "2";
		process.env.BUZZ_STUB_STDOUT = "";
		process.env.BUZZ_STUB_STDERR = JSON.stringify({
			error: "relay_error",
			message: "relay returned 503",
			retryable: true,
		});

		const error = await client()
			.sendMessage({ channelId: "chan-1", content: "hi" })
			.catch((e) => e as BuzzCliError);

		expect(error).toBeInstanceOf(BuzzCliError);
		expect(error.category).toBe("relay_error");
		expect(error.retryable).toBe(true);
		expect(error.exitCode).toBe(2);
		expect(error.message).toContain("relay returned 503");
	});

	// Exit code 5 is a NIP-33 write conflict, which is worth retrying even when
	// the payload does not say so.
	it("treats a write conflict as retryable", async () => {
		process.env.BUZZ_STUB_EXIT = "5";
		process.env.BUZZ_STUB_STDOUT = "";
		process.env.BUZZ_STUB_STDERR = "not json";

		const error = await client()
			.sendMessage({ channelId: "chan-1", content: "hi" })
			.catch((e) => e as BuzzCliError);

		expect(error.retryable).toBe(true);
	});

	it("explains an ENOENT as a probably-unbuilt binary", async () => {
		const missing = new BuzzCliClient({
			binaryPath: join(dir, "does-not-exist"),
			relayUrl: "https://relay.example.com",
			privateKey: "nsec-test",
		});

		const error = await missing
			.sendMessage({ channelId: "chan-1", content: "hi" })
			.catch((e) => e as BuzzCliError);

		expect(error.message).toContain("binary named 'buzz'");
	});

	it("rejects a relay-refused write", async () => {
		process.env.BUZZ_STUB_STDOUT = JSON.stringify({
			event_id: "",
			accepted: false,
			message: "not a member of this channel",
		});

		await expect(
			client().sendMessage({ channelId: "chan-1", content: "hi" }),
		).rejects.toThrow(/not a member of this channel/);
	});
});

/**
 * Drift guard against the real binary. Skipped unless `BUZZ_CLI_PATH` names an
 * executable, so a developer without the Rust toolchain can still run the
 * suite — but wherever the binary IS available (the deployment host, and any
 * CI job that builds it), an upstream flag rename fails here.
 */
const realCliPath = process.env.BUZZ_CLI_PATH;
const realCliAvailable = (() => {
	if (!realCliPath) return false;
	try {
		execFileSync(realCliPath, ["--version"], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
})();

describe.skipIf(!realCliAvailable)("buzz-cli surface (real binary)", () => {
	function help(...args: string[]): string {
		return execFileSync(realCliPath as string, [...args, "--help"], {
			encoding: "utf8",
		});
	}

	it("still documents the messages-send flags we build", () => {
		const out = help("messages", "send");
		for (const flag of ["--channel", "--content", "--reply-to"]) {
			expect(out).toContain(flag);
		}
	});

	it("still documents the messages-thread flags we build", () => {
		const out = help("messages", "thread");
		for (const flag of ["--channel", "--event"]) {
			expect(out).toContain(flag);
		}
	});

	it("still documents the reactions-add flags we build", () => {
		const out = help("reactions", "add");
		for (const flag of ["--event", "--emoji"]) {
			expect(out).toContain(flag);
		}
	});
});
