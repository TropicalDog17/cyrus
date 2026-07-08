import { describe, expect, it } from "vitest";
import { READONLY_DEFAULT_ALLOWED_TOOLS } from "../src/allowed-tools-defaults";

/**
 * Regression coverage for DEV-125.
 *
 * The read-only preset exists so Cyrus can answer "look at the code in repo X"
 * questions: it grants Read access to repository sources and `git -C * pull`
 * to refresh a repo "before grepping it". But Cyrus has no native Grep/Glob
 * tool — all code search flows through Bash — so a read-only session that runs
 * `grep` was denied ("Permission to use Bash with command grep ... has been
 * denied"), making the preset's stated purpose impossible.
 */
describe("READONLY_DEFAULT_ALLOWED_TOOLS", () => {
	it("permits grep so read-only sessions can search repository sources", () => {
		const allowsGrep = READONLY_DEFAULT_ALLOWED_TOOLS.some((tool) =>
			/^Bash\(grep[\s(:]/.test(tool),
		);
		expect(allowsGrep).toBe(true);
	});

	it("stays read-only — no bare Bash, Edit, Write, or NotebookEdit", () => {
		const tools = READONLY_DEFAULT_ALLOWED_TOOLS as readonly string[];
		expect(tools).not.toContain("Bash");
		expect(tools).not.toContain("Edit");
		expect(tools).not.toContain("Edit(**)");
		expect(tools).not.toContain("Write");
		expect(tools).not.toContain("Write(**)");
		expect(tools).not.toContain("NotebookEdit");
	});
});
