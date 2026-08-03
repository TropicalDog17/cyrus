export type GateFindingTag = "recurring" | "one-off";

export type GateCommand =
	| { type: "approve" }
	| {
			type: "request-changes";
			findings: { text: string; tag: GateFindingTag }[];
	  }
	| { type: "reject"; reason: string }
	| { type: "escalate"; reason: string };

/** Parses only complete, host-recognized gate commands. */
export function parseGateCommand(body: string): GateCommand | undefined {
	const [firstLine, ...followingLines] = body.trim().split(/\r?\n/);
	const [command, ...firstLineArgs] = (firstLine ?? "").trim().split(/\s+/);
	const lines = [
		firstLineArgs.join(" ").trim(),
		...followingLines.map((line) => line.trim()),
	].filter(Boolean);
	if (command === "/approve" && lines.length === 0) return { type: "approve" };
	if (command === "/request-changes") {
		const findings = lines.map(parseFinding);
		if (findings.length === 0 || findings.some((finding) => !finding)) {
			return undefined;
		}
		return {
			type: "request-changes",
			findings: findings as { text: string; tag: GateFindingTag }[],
		};
	}
	if (command === "/reject" || command === "/escalate") {
		const reason = lines.join("\n").trim();
		return reason
			? { type: command.slice(1) as "reject" | "escalate", reason }
			: undefined;
	}
	return undefined;
}

function parseFinding(
	line: string,
): { text: string; tag: GateFindingTag } | undefined {
	const match = /^(.*?)::(recurring|one-off)$/.exec(line.trim());
	const text = match?.[1]?.trim();
	const tag = match?.[2];
	if (!text || (tag !== "recurring" && tag !== "one-off")) return undefined;
	return { text, tag };
}
