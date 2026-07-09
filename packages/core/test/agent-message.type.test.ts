import { describe, expect, it } from "vitest";
import type { AgentMessage, AgentUsage } from "../src/agent-runner-types.js";

/**
 * Compile-time + runtime lock on the neutral AgentMessage discriminated union.
 * Phase C's ActivityMapper folds the two runner formatters into a single
 * `map(msg)` switch keyed on these `type`/`subtype`/block shapes, so this test
 * exhaustively narrows the union (with a `never` guard) to catch any accidental
 * change to the variant set.
 */
function summarize(msg: AgentMessage): string {
	switch (msg.type) {
		case "system":
			switch (msg.subtype) {
				case "init":
					return `init:${msg.sessionId}:${msg.model}`;
				case "status":
					return `status:${msg.status}`;
				default: {
					const _never: never = msg;
					return _never;
				}
			}
		case "assistant":
			return msg.content
				.map((b) => {
					switch (b.type) {
						case "text":
							return `text:${b.text}`;
						case "thinking":
							return `thinking:${b.thinking}`;
						case "tool_use":
							return `tool_use:${b.id}:${b.name}`;
						default: {
							const _never: never = b;
							return _never;
						}
					}
				})
				.join(",");
		case "user":
			return msg.content
				.map((b) => {
					switch (b.type) {
						case "text":
							return `text:${b.text}`;
						case "tool_result":
							return `tool_result:${b.toolUseId}:${b.isError}:${b.content}`;
						default: {
							const _never: never = b;
							return _never;
						}
					}
				})
				.join(",");
		case "result":
			switch (msg.subtype) {
				case "success":
					return `success:${msg.result}:${msg.usage.costUsd}`;
				case "error":
					return `error:${msg.errors.join("|")}`;
				default: {
					const _never: never = msg;
					return _never;
				}
			}
		case "rate_limit":
			return `rate_limit:${msg.info.status}`;
		default: {
			const _never: never = msg;
			return _never;
		}
	}
}

describe("AgentMessage neutral union", () => {
	it("narrows exhaustively over every variant", () => {
		expect(
			summarize({
				type: "system",
				subtype: "init",
				sessionId: "s",
				model: "m",
				tools: [],
			}),
		).toBe("init:s:m");
		expect(
			summarize({
				type: "assistant",
				sessionId: "s",
				parentToolUseId: null,
				content: [
					{ type: "text", text: "hi" },
					{ type: "thinking", thinking: "hmm" },
					{ type: "tool_use", id: "t1", name: "Read", input: {} },
				],
			}),
		).toBe("text:hi,thinking:hmm,tool_use:t1:Read");
		expect(
			summarize({
				type: "user",
				sessionId: "s",
				parentToolUseId: "t1",
				content: [
					{
						type: "tool_result",
						toolUseId: "t1",
						isError: false,
						content: "ok",
					},
				],
			}),
		).toBe("tool_result:t1:false:ok");
		expect(
			summarize({
				type: "result",
				subtype: "success",
				sessionId: "s",
				result: "done",
				isError: false,
				durationMs: 1,
				usage: {
					inputTokens: 0,
					outputTokens: 0,
					cacheReadTokens: 0,
					cacheWriteTokens: 0,
					costUsd: 0.5,
				},
			}),
		).toBe("success:done:0.5");
		expect(
			summarize({
				type: "rate_limit",
				sessionId: "s",
				info: { status: "rejected" },
			}),
		).toBe("rate_limit:rejected");
	});

	it("keeps AgentUsage free of Anthropic cache-bucket keys", () => {
		const usage: AgentUsage = {
			inputTokens: 1,
			outputTokens: 2,
			cacheReadTokens: 3,
			cacheWriteTokens: 4,
			costUsd: 5,
		};
		expect(Object.keys(usage).sort()).toEqual([
			"cacheReadTokens",
			"cacheWriteTokens",
			"costUsd",
			"inputTokens",
			"outputTokens",
		]);
		// Anthropic bucket names must not leak into the neutral usage shape.
		const forbidden = [
			"cache_creation_input_tokens",
			"cache_read_input_tokens",
			"cache_creation",
		];
		for (const key of forbidden) {
			expect(usage).not.toHaveProperty(key);
		}
	});
});
