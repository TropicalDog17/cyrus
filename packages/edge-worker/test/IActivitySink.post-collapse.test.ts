import { AgentActivitySignal, type IIssueTrackerService } from "cyrus-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LinearActivitySink } from "../src/sinks/LinearActivitySink.js";
import { NoopActivitySink } from "../src/sinks/NoopActivitySink.js";

/**
 * The collapsed post path: every activity-post funnels through
 * IActivitySink.post(sessionId, activity), with ephemeral/signal/signalMetadata
 * riding inline on the neutral Activity. Replaces the option-passthrough cases
 * that used to live in LinearActivitySink.test.ts under the 3-arg signature.
 */
describe("NoopActivitySink.post", () => {
	it("discards activities and returns an empty result", async () => {
		const sink = new NoopActivitySink("noop-1");
		await expect(
			sink.post("session-1", { type: "thought", body: "ignored" }),
		).resolves.toEqual({});
	});
});

describe("LinearActivitySink.post — modifier splitting", () => {
	let createAgentActivity: ReturnType<typeof vi.fn>;
	let sink: LinearActivitySink;
	const sessionId = "session-1";

	beforeEach(() => {
		createAgentActivity = vi.fn().mockResolvedValue({
			success: true,
			agentActivity: Promise.resolve({ id: "activity-1" }),
		});
		sink = new LinearActivitySink(
			{ createAgentActivity } as unknown as IIssueTrackerService,
			"workspace-1",
		);
	});

	it("forwards content-only activities without modifiers", async () => {
		await sink.post(sessionId, { type: "thought", body: "Analyzing…" });
		expect(createAgentActivity).toHaveBeenCalledWith({
			agentSessionId: sessionId,
			content: { type: "thought", body: "Analyzing…" },
		});
	});

	it("splits ephemeral off the activity into the create input", async () => {
		await sink.post(sessionId, {
			type: "thought",
			body: "Compacting…",
			ephemeral: true,
		});
		expect(createAgentActivity).toHaveBeenCalledWith({
			agentSessionId: sessionId,
			content: { type: "thought", body: "Compacting…" },
			ephemeral: true,
		});
	});

	it("maps an elicitation with a Select signal + options metadata", async () => {
		await sink.post(sessionId, {
			type: "elicitation",
			body: "Which repository?",
			signal: "select",
			signalMetadata: { options: [{ value: "repo-a" }, { value: "repo-b" }] },
		});
		expect(createAgentActivity).toHaveBeenCalledWith({
			agentSessionId: sessionId,
			content: { type: "elicitation", body: "Which repository?" },
			signal: AgentActivitySignal.Select,
			signalMetadata: { options: [{ value: "repo-a" }, { value: "repo-b" }] },
		});
	});

	it("maps an auth signal with url metadata", async () => {
		await sink.post(sessionId, {
			type: "elicitation",
			body: "Please approve",
			signal: "auth",
			signalMetadata: { url: "https://example.com/approve" },
		});
		expect(createAgentActivity).toHaveBeenCalledWith({
			agentSessionId: sessionId,
			content: { type: "elicitation", body: "Please approve" },
			signal: AgentActivitySignal.Auth,
			signalMetadata: { url: "https://example.com/approve" },
		});
	});

	it("returns the created activity id", async () => {
		const result = await sink.post(sessionId, {
			type: "response",
			body: "Done",
		});
		expect(result).toEqual({ activityId: "activity-1" });
	});
});
