import {
	chmod,
	mkdir,
	mkdtemp,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	AgenticPipelineClient,
	PipelineFactError,
	PipelineTimeoutError,
} from "../src/closure/AgenticPipelineClient.js";

let root: string;
let dataPath: string;
let logPath: string;
let fakeUvPath: string;

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "cyrus-pipeline-client-"));
	dataPath = join(root, "data");
	logPath = join(root, "invocations.jsonl");
	fakeUvPath = join(root, "fake-uv.mjs");
	await writeFile(
		fakeUvPath,
		`#!/usr/bin/env node
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { join } from "node:path";
const args = process.argv.slice(2);
await appendFile(process.env.FAKE_PIPELINE_LOG, JSON.stringify({ args, env: {
  root: process.env.AGENTIC_PIPELINE_ROOT,
  data: process.env.AGENTIC_PIPELINE_DATA,
  config: process.env.CYRUS_CONFIG,
} }) + "\\n");
if (args[0] === "--version") { console.log("uv 0.7.0"); process.exit(0); }
if (process.env.FAKE_PIPELINE_MODE === "hang") { await delay(60_000); }
const command = args.slice(3);
const gates = join(process.env.AGENTIC_PIPELINE_DATA, "gates");
await mkdir(gates, { recursive: true });
if (command[0] === "pr-watch") {
  await writeFile(join(gates, "RUN-42.pr.json"), JSON.stringify({
    run_id: "RUN-42", issue_id: "ENG-42", repo: "repo-one", repo_dir: "/repo-one",
    number: 42, head_sha: "sha-a", base: "main"
  }));
  console.log(JSON.stringify({ results: [{ run_id: "RUN-42", captured: true }], liveness: {} }));
  process.exit(0);
}
if (command[0] === "gate" && command[1] === "human") {
  await writeFile(join(gates, "RUN-42.human.json"), JSON.stringify({
    verdict: "needs-rework", head_sha: "sha-a", findings: [{ text: "missing test", tag: "recurring" }]
  }));
  console.log(JSON.stringify({ verdict: "needs-rework" }));
  process.exit(0);
}
console.log(process.env.FAKE_PIPELINE_MODE === "bad-json" ? "not json" : JSON.stringify({ ok: true }));
`,
	);
	await chmod(fakeUvPath, 0o755);
});

afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

function makeClient(mode?: string) {
	return new AgenticPipelineClient({
		config: { enabled: true, projectPath: root, dataPath },
		cyrusConfigPath: join(root, "cyrus-config.json"),
		uvCommand: fakeUvPath,
		timeoutMs: 100,
		env: mode
			? { FAKE_PIPELINE_MODE: mode, FAKE_PIPELINE_LOG: logPath }
			: { FAKE_PIPELINE_LOG: logPath },
	});
}

describe("AgenticPipelineClient", () => {
	it("runs pr-watch through fixed argv and accepts only a valid durable PR fact", async () => {
		const client = makeClient();
		await client.initialize();

		const watch = await client.watch("repo-one");
		const fact = await client.readPrFact("RUN-42");
		const invocations = (await readFile(logPath, "utf8"))
			.trim()
			.split("\n")
			.map(
				(line) =>
					JSON.parse(line) as { args: string[]; env: Record<string, string> },
			);

		expect(watch.results).toEqual([{ run_id: "RUN-42", captured: true }]);
		expect(fact).toMatchObject({
			run_id: "RUN-42",
			number: 42,
			head_sha: "sha-a",
		});
		expect(invocations).toContainEqual({
			args: ["run", "--project", root, "pr-watch", "--repo", "repo-one"],
			env: { root, data: dataPath, config: join(root, "cyrus-config.json") },
		});
	});

	it("passes tagged findings as repeatable gate-human arguments and validates its fact", async () => {
		const client = makeClient();
		await client.initialize();

		const human = await client.recordHumanVerdict("RUN-42", "needs-rework", [
			{ text: "missing test", tag: "recurring" },
		]);
		const invocations = await readFile(logPath, "utf8");

		expect(human).toMatchObject({ verdict: "needs-rework", head_sha: "sha-a" });
		expect(invocations).toContain(
			'"gate","human","--run-id","RUN-42","--verdict","needs-rework","--finding","missing test::recurring"',
		);
	});

	it("rejects malformed command stdout rather than treating it as a pipeline result", async () => {
		const client = makeClient("bad-json");
		await client.initialize();

		await expect(client.review("RUN-42")).rejects.toThrow(PipelineFactError);
	});

	it("rejects malformed durable PR metadata rather than admitting a candidate", async () => {
		const client = makeClient();
		await client.initialize();
		await mkdir(join(dataPath, "gates"), { recursive: true });
		await writeFile(
			join(dataPath, "gates", "RUN-bad.pr.json"),
			'{"run_id": 42}',
		);

		await expect(client.readPrFact("RUN-bad")).rejects.toThrow(
			PipelineFactError,
		);
	});

	it("times out and fails closed when a pipeline process does not return", async () => {
		const client = makeClient("hang");
		await client.initialize();

		await expect(client.review("RUN-42")).rejects.toThrow(PipelineTimeoutError);
	});
});
