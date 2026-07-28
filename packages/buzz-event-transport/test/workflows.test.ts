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
};

describe("buzz-workflow definitions", () => {
	// One file, one trigger, and `message_posted` is the only one Cyrus wants
	// delivered. A reaction workflow would carry `{{trigger.author}}`, which
	// buzz-workflow reads from an unsigned `actor` tag — so shipping one would
	// hand any channel member a way to name an allowlisted pubkey as the reactor
	// and release an execution gate. Reactions come from the relay instead.
	it("ships exactly one workflow, for message_posted", () => {
		expect(readdirSync(WORKFLOWS_DIR).sort()).toEqual(["cyrus-trigger.yaml"]);

		expect(readWorkflow("cyrus-trigger.yaml").trigger).toBe("message_posted");
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

	// `{{trigger.text}}` is a chat message substituted raw into JSON: the body
	// stops parsing the first time somebody types a quote or a newline. The
	// header comment warns about it by name, so only the body is checked.
	it("templates no free text into the body", () => {
		expect(readWorkflow("cyrus-trigger.yaml").bodyTemplate).not.toContain(
			"{{trigger.text}}",
		);
	});
});
