import { readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
	readWorkflow,
	renderWorkflowBody,
	WORKFLOWS_DIR,
} from "./workflow-fixtures.js";

const IDENTITY_TRIGGER = {
	message_id: "{{trigger.message_id}}",
	channel_id: "{{trigger.channel_id}}",
	author: "{{trigger.author}}",
	timestamp: "{{trigger.timestamp}}",
	emoji: "{{trigger.emoji}}",
};

describe("buzz-workflow definitions", () => {
	// buzz-workflow's `TriggerDef` is a serde internally-tagged enum on `on:`,
	// so one file declares exactly one trigger. Reactions therefore need a file
	// of their own, and installing only one of the pair looks from the channel
	// like the agent ignoring a reaction.
	it("ships one workflow file per trigger Cyrus routes", () => {
		expect(readdirSync(WORKFLOWS_DIR).sort()).toEqual([
			"cyrus-reaction.yaml",
			"cyrus-trigger.yaml",
		]);

		expect([
			readWorkflow("cyrus-trigger.yaml").trigger,
			readWorkflow("cyrus-reaction.yaml").trigger,
		]).toEqual(["message_posted", "reaction_added"]);
	});

	it("declares an id-shaped message_posted body", () => {
		expect(renderWorkflowBody("cyrus-trigger.yaml", IDENTITY_TRIGGER)).toEqual({
			type: "message_posted",
			message_id: "{{trigger.message_id}}",
			channel_id: "{{trigger.channel_id}}",
			author: "{{trigger.author}}",
			timestamp: "{{trigger.timestamp}}",
		});
	});

	it("declares an id-shaped reaction_added body carrying the emoji", () => {
		expect(renderWorkflowBody("cyrus-reaction.yaml", IDENTITY_TRIGGER)).toEqual(
			{
				type: "reaction_added",
				message_id: "{{trigger.message_id}}",
				channel_id: "{{trigger.channel_id}}",
				author: "{{trigger.author}}",
				timestamp: "{{trigger.timestamp}}",
				emoji: "{{trigger.emoji}}",
			},
		);
	});

	// `{{trigger.text}}` is a chat message substituted raw into JSON: the body
	// stops parsing the first time somebody types a quote or a newline. The
	// header comments warn about it by name, so only the bodies are checked.
	it("templates no free text into either body", () => {
		for (const fileName of ["cyrus-trigger.yaml", "cyrus-reaction.yaml"]) {
			expect(readWorkflow(fileName).bodyTemplate).not.toContain(
				"{{trigger.text}}",
			);
		}
	});
});
