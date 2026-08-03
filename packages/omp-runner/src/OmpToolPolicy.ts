import type { OmpToolPolicyRender } from "cyrus-core";
import type { OmpPermissionPolicy } from "./types.js";

/**
 * The OMP permission-policy adapter. Wraps the pure render produced by
 * `renderOmpToolPolicy` (cyrus-core) — the runner never recomputes paths or
 * policy. Decisions:
 *   - a deny entry matching the operation → reject;
 *   - a deny-detail entry matching the operation AND the request detail → reject;
 *   - an allow entry matching the operation → allow;
 *   - anything else → reject (fail closed; `always-ask` surfaces the request,
 *     and there is deliberately no path that widens the OS sandbox).
 */
export class OmpToolPolicy implements OmpPermissionPolicy {
	constructor(private readonly render: OmpToolPolicyRender) {}

	allowsTool(operation: string, detail?: string): boolean {
		const op = operation.toLowerCase();

		if (this.render.deny.some((entry) => matches(entry, op))) {
			return false;
		}

		const detailText = (detail ?? "").toLowerCase();
		if (
			this.render.denyDetails.some(
				({ operation: deniedOp, needle }) =>
					matches(deniedOp, op) && detailText.includes(needle.toLowerCase()),
			)
		) {
			return false;
		}

		if (this.render.allow.some((entry) => matches(entry, op))) {
			return true;
		}

		return false;
	}
}

/**
 * Pattern match against a lowercased operation name. Supports exact names,
 * `mcp__server_*` prefixes, and trailing-`*` globs.
 */
function matches(pattern: string, operation: string): boolean {
	if (pattern.endsWith("*")) {
		return operation.startsWith(pattern.slice(0, -1));
	}
	if (operation === pattern) return true;
	// mcp__server allow entries cover every tool on that server.
	if (operation.startsWith(`${pattern}_`)) return true;
	return false;
}
