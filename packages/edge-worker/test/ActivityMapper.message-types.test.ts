import { describe, expect, test } from "vitest";
import { ActivityMapper } from "../src/activity/ActivityMapper.js";
import type { MapContext } from "../src/activity/MapContext.js";
import {
	assistantMessage,
	assistantText,
	assistantThinking,
	assistantToolUse,
	resultError,
	resultSuccess,
	systemInitMessage,
} from "./agent-message-builders.js";

const mapper = new ActivityMapper();
const ctx: MapContext = {
	provider: "claude",
	toolCall: () => undefined,
	taskSubjectById: () => undefined,
};

describe("ActivityMapper non-tool message mapping", () => {
	test("assistant text -> thought", () => {
		const [a] = mapper.map(assistantText("Exploring the codebase."), ctx);
		expect(a).toEqual({ type: "thought", body: "Exploring the codebase." });
	});

	test("assistant thinking block -> thought (Cursor data-loss fix)", () => {
		const [a] = mapper.map(assistantThinking("Considering the approach"), ctx);
		expect(a).toEqual({ type: "thought", body: "Considering the approach" });
	});

	test("empty text -> no activity", () => {
		expect(mapper.map(assistantText(""), ctx)).toEqual([]);
	});

	test("whitespace-only text -> no activity", () => {
		expect(mapper.map(assistantText("\n \t"), ctx)).toEqual([]);
	});

	test("assistant provider error -> error", () => {
		const msg = assistantMessage(
			[{ type: "text", text: "Usage limit reached" }],
			{
				// SDKAssistantMessageError tag; shape is provider-internal.
				error: "rate_limit" as never,
			},
		);
		const [a] = mapper.map(msg, ctx);
		expect(a).toEqual({ type: "error", body: "Usage limit reached" });
	});

	test("AskUserQuestion tool_use -> no activity (handled via elicitation)", () => {
		expect(
			mapper.map(
				assistantToolUse("tu", "AskUserQuestion", { question: "?" }),
				ctx,
			),
		).toEqual([]);
	});

	test("result success -> response", () => {
		const [a] = mapper.map(resultSuccess("All done"), ctx);
		expect(a).toEqual({ type: "response", body: "All done" });
	});

	test("result error -> error", () => {
		const [a] = mapper.map(resultError(["boom", "kaput"]), ctx);
		expect(a).toEqual({ type: "error", body: "boom\nkaput" });
	});

	test("system init -> no activity (model notification/status owned by ASM)", () => {
		expect(mapper.map(systemInitMessage(), ctx)).toEqual([]);
	});
});
