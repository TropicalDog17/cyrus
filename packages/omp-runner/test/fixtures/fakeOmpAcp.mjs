#!/usr/bin/env node
/**
 * Fake `omp acp` ACP server for runner tests. Speaks the ACP stdio NDJSON
 * protocol the runner drives: initialize, session/new, session/resume,
 * session/prompt (with session/update notifications), session/cancel, plus
 * failure scenarios (permission request, malformed frames, prompt-time exit,
 * capability refusal).
 *
 * Behavior is selected via FAKE_OMP_SCENARIO:
 *   - success      (default): text + a completed Bash tool call, then end_turn
 *   - permission:  a requestPermission notification for a Bash command
 *   - malformed:   a non-JSON line on stdout mid-prompt
 *   - exit:        process exits while a prompt is in flight
 *   - wrong-name:  initialize reports an agent name other than "oh-my-pi"
 *   - no-resume:   initialize omits the session.resume capability
 */
import { createInterface } from "node:readline";

const scenario = process.env.FAKE_OMP_SCENARIO || "success";
const sessionId = process.env.FAKE_OMP_SESSION_ID || "fixture-sess-1";

const rl = createInterface({ input: process.stdin });
let seq = 0;

function send(message) {
	process.stdout.write(JSON.stringify(message) + "\n");
}

function notify(update) {
	send({
		jsonrpc: "2.0",
		method: "session/update",
		params: { sessionId, update },
	});
}

function delay(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function handlePrompt() {
	await delay(30);
	notify({ sessionUpdate: "agent_message_chunk", messageId: "m1", content: { type: "text", text: "Working on it" } });
	notify({ sessionUpdate: "agent_message_chunk", messageId: "m1", content: { type: "text", text: " now" } });
	notify({ sessionUpdate: "tool_call", toolCallId: "tc-1", kind: "execute", title: "Run command", rawInput: { command: "echo hi" }, status: "running" });
	notify({ sessionUpdate: "tool_call_update", toolCallId: "tc-1", kind: "execute", status: "completed", content: [{ type: "content", content: { type: "text", text: "hi" } }] });
	notify({ sessionUpdate: "agent_message_chunk", messageId: "m2", content: { type: "text", text: "Done." } });

	if (scenario === "permission") {
		// requestPermission is a CLIENT method: the server sends an ID'd request
		// and the client responds by selecting an option.
		send({
			jsonrpc: "2.0",
			id: "perm-1",
			method: "session/request_permission",
			params: {
				sessionId,
				toolCall: {
					toolCallId: "tc-perm",
					kind: "execute",
					title: "Run command",
					rawInput: { command: "rm -rf /home" },
					status: "pending",
				},
				options: [
					{ optionId: "allow-once", name: "Allow once", kind: "allow_once" },
					{ optionId: "reject-always", name: "Reject always", kind: "reject_always" },
				],
			},
		});
	}

	if (scenario === "malformed") {
		process.stdout.write("this is not json\n");
		await delay(20);
	}

	if (scenario === "exit") {
		process.exit(0);
	}

	if (scenario === "wrong-name" || scenario === "no-resume") {
		// These fail at initialize; prompt should never be reached.
		process.exit(0);
	}

	await delay(20);
	return { stopReason: "end_turn", usage: { inputTokens: 100, outputTokens: 50, cachedReadTokens: 10, cachedWriteTokens: 5 } };
}

rl.on("line", async (line) => {
	let message;
	try {
		message = JSON.parse(line);
	} catch {
		send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
		return;
	}

	const { id, method, params } = message;

	switch (method) {
		case "initialize": {
			if (scenario === "wrong-name") {
				send({
					jsonrpc: "2.0",
					id,
					result: {
						protocolVersion: 1,
						agentInfo: { name: "other-agent", title: "Other", version: "1.0.0" },
						agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {} }, mcpCapabilities: { http: true, sse: true } },
					},
				});
				return;
			}
			if (scenario === "no-resume") {
				send({
					jsonrpc: "2.0",
					id,
					result: {
						protocolVersion: 1,
						agentInfo: { name: "oh-my-pi", title: "Oh My Pi", version: "17.2.4" },
						agentCapabilities: { loadSession: true, sessionCapabilities: {}, mcpCapabilities: { http: true, sse: true } },
					},
				});
				return;
			}
			send({
				jsonrpc: "2.0",
				id,
				result: {
					protocolVersion: 1,
					agentInfo: { name: "oh-my-pi", title: "Oh My Pi", version: "17.2.4" },
					authMethods: [{ id: "agent", name: "Local credentials" }],
					agentCapabilities: {
						loadSession: true,
						sessionCapabilities: { resume: {} },
						mcpCapabilities: { http: true, sse: true },
					},
				},
			});
			return;
		}
		case "session/new":
			send({ jsonrpc: "2.0", id, result: { sessionId: sessionId || "fixture-new-session", configOptions: [] } });
			return;
		case "session/resume":
			send({ jsonrpc: "2.0", id, result: { sessionId: params.sessionId, configOptions: [] } });
			return;
		case "session/prompt": {
			const response = await handlePrompt();
			send({ jsonrpc: "2.0", id, result: response });
			return;
		}
		case "session/cancel":
			send({ jsonrpc: "2.0", id, result: { ok: true } });
			process.exit(0);
			return;
		default:
			send({ jsonrpc: "2.0", id, error: { code: -32601, message: `method not found: ${method}` } });
	}
});
