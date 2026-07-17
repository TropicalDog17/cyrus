/**
 * Prompt Assembly Tests - Continuation Sessions
 *
 * Tests prompt assembly for continuation (non-streaming, non-new) sessions.
 */

import { describe, it } from "vitest";
import { createTestWorker, scenario } from "./prompt-assembly-utils.js";

describe("Prompt Assembly - Continuation Sessions", () => {
	it("should wrap comment in XML with author and timestamp", async () => {
		const worker = createTestWorker();

		await scenario(worker)
			.continuationSession()
			.withUserComment("Please fix the bug")
			.withCommentAuthor("Alice Smith")
			.withCommentTimestamp("2025-01-27T12:00:00Z")
			.expectUserPrompt(`<new_comment>
  <author>Alice Smith</author>
  <timestamp>2025-01-27T12:00:00Z</timestamp>
  <content>
Please fix the bug
  </content>
</new_comment>`)
			.expectSystemPrompt(undefined)
			.expectComponents("user-comment")
			.expectPromptType("continuation")
			.verify();
	});

	it("should include attachments if present", async () => {
		const worker = createTestWorker();

		await scenario(worker)
			.continuationSession()
			.withUserComment("Here's more context")
			.withCommentAuthor("Bob Jones")
			.withCommentTimestamp("2025-01-27T13:30:00Z")
			.withAttachments(`
## New Attachments from Comment

Downloaded 1 new attachment.

### New Attachments
1. attachment_0001.txt - Original URL: https://linear.app/attachments/error-log.txt
   Local path: /path/to/attachments/attachment_0001.txt

You can use the Read tool to view these files.
`)
			.expectUserPrompt(`<new_comment>
  <author>Bob Jones</author>
  <timestamp>2025-01-27T13:30:00Z</timestamp>
  <content>
Here's more context
  </content>
</new_comment>


## New Attachments from Comment

Downloaded 1 new attachment.

### New Attachments
1. attachment_0001.txt - Original URL: https://linear.app/attachments/error-log.txt
   Local path: /path/to/attachments/attachment_0001.txt

You can use the Read tool to view these files.
`)
			.expectSystemPrompt(undefined)
			.expectComponents("user-comment", "attachment-manifest")
			.expectPromptType("continuation")
			.verify();
	});

	it("should default to Unknown author and omit the timestamp line when neither is provided", async () => {
		const worker = createTestWorker();

		// With no source timestamp, the <timestamp> line is omitted entirely so
		// the assembled prompt stays reproducible (no wall-clock fallback).
		await scenario(worker)
			.continuationSession()
			.withUserComment("Update the docs")
			.expectUserPrompt(`<new_comment>
  <author>Unknown</author>
  <content>
Update the docs
  </content>
</new_comment>`)
			.expectSystemPrompt(undefined)
			.expectComponents("user-comment")
			.expectPromptType("continuation")
			.verify();
	});
});
