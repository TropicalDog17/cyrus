import { describe, expect, it } from "vitest";
import {
	type Ask,
	CONFIG_KEY_RE,
	choreBlockReason,
	choreRuleFires,
	explain,
	type FetchLabels,
	FILE_RE,
	Issue,
	issuePayload,
	namesConcreteTarget,
	parseLabelSelection,
	promptIssue,
	type RouteConfig,
	route,
	wordCount,
} from "../src/route.js";

// Ported from tests/test_route.py
const NO_LABELS: FetchLabels = () => null; // force the free-text path (no network) in tests

const CFG: RouteConfig = {
	work_repos: ["work-monorepo"],
	chore: { max_body_words: 50, require_concrete_target: true },
	small: { max_estimate_points: 2 },
	audit: { sample_every: 5 },
};

describe("route decision table", () => {
	it("chore with a concrete target auto-approves the spec gate", () => {
		const issue = new Issue({
			repo: "p",
			labels: ["chore"],
			body: "bump flask to flask==3.0 in requirements.txt",
		});
		const d = route(issue, CFG);
		expect(d.tier).toBe("chore");
		expect(d.spec_gate).toBe("auto");
		expect(d.diff_gate).toBe("manual");
	});

	it("chore without a concrete target is not a chore", () => {
		const issue = new Issue({
			repo: "p",
			labels: ["chore"],
			body: "please tidy things up a bit",
		});
		expect(route(issue, CFG).tier).toBe("feature");
	});

	it("chore with too long a body is not a chore", () => {
		const body = `update config.yaml ${Array(60).fill("word").join(" ")}`;
		expect(wordCount(body)).toBeGreaterThan(50);
		expect(
			route(new Issue({ repo: "p", labels: ["chore"], body }), CFG).tier,
		).toBe("feature");
	});

	it("a work repo is always full and never chore", () => {
		const issue = new Issue({
			repo: "work-monorepo",
			labels: ["chore"],
			body: "bump dep in package.json",
		});
		const d = route(issue, CFG);
		expect(d.tier).toBe("full");
		expect(d.spec_gate).toBe("manual");
	});

	it("small tier requires an estimate and a single repo", () => {
		expect(route(new Issue({ repo: "p", estimate: 2 }), CFG).tier).toBe(
			"small",
		);
		expect(
			route(new Issue({ repo: "p", estimate: 2, multi_repo: true }), CFG).tier,
		).toBe("feature");
		expect(route(new Issue({ repo: "p", estimate: 5 }), CFG).tier).toBe(
			"feature",
		);
	});

	it("a missing estimate falls to feature", () => {
		// Devtrop has estimation disabled -> estimate is null -> never `small`.
		expect(route(new Issue({ repo: "p", estimate: null }), CFG).tier).toBe(
			"feature",
		);
	});

	it("the diff gate is always manual on every tier", () => {
		for (const issue of [
			new Issue({ repo: "work-monorepo" }),
			new Issue({ repo: "p", labels: ["chore"], body: "edit a.py" }),
			new Issue({ repo: "p", estimate: 1 }),
			new Issue({ repo: "p" }),
		]) {
			expect(route(issue, CFG).diff_gate).toBe("manual");
		}
	});

	it("a multi-repo chore is fenced (never auto-skips the spec gate)", () => {
		// A multi-repo chore has higher blast radius — it must not auto-skip the spec gate,
		// mirroring the small-tier fence, even though it names a concrete target and is short.
		const issue = new Issue({
			repo: "p",
			labels: ["chore"],
			body: "bump shared eslint in `.eslintrc.json`",
			multi_repo: true,
		});
		const d = route(issue, CFG);
		expect(d.tier).not.toBe("chore");
		expect(d.spec_gate).toBe("manual");
		const reason = choreBlockReason(issue, CFG);
		expect(reason).toContain("multi-repo");
	});
});

describe("prompt_issue", () => {
	// Fake `ask` that returns queued, stripped answers — mirrors _ask's contract.
	function scriptedAsk(answers: string[]): Ask {
		const it = answers[Symbol.iterator]();
		return () => (it.next().value as string).trim();
	}

	it("gathers the issue fields", () => {
		const issue = promptIssue(
			scriptedAsk(["Daily_You", "chore, bug", "edit a.py", "", "y"]),
			NO_LABELS,
		);
		expect(issue.repo).toBe("Daily_You");
		expect(issue.labels).toEqual(["chore", "bug"]);
		expect(issue.body).toBe("edit a.py");
		expect(issue.estimate).toBeNull();
		expect(issue.multi_repo).toBe(true);
	});

	it("re-prompts on a bad estimate and an empty repo", () => {
		// repo: blank + whitespace rejected before "p"; estimate: "nope" rejected before "3".
		const issue = promptIssue(
			scriptedAsk(["", "   ", "p", "", "", "nope", "3", "n"]),
			NO_LABELS,
		);
		expect(issue.repo).toBe("p");
		expect(issue.labels).toEqual([]);
		expect(issue.estimate).toBe(3);
		expect(issue.multi_repo).toBe(false);
	});

	it("label picker mixes menu numbers and free names", () => {
		// Live-Linear picker path: choices offered, reply mixes menu numbers and a free name.
		const issue = promptIssue(
			scriptedAsk(["p", "1, 3, custom-label", "edit a.py", "", "n"]),
			() => ["chore", "PRD", "Orchestrator", "rework-of"],
		);
		expect(issue.labels).toEqual(["chore", "Orchestrator", "custom-label"]);
	});
});

describe("parseLabelSelection", () => {
	it("parses comma-separated menu numbers and literal names", () => {
		const choices = ["chore", "PRD", "Orchestrator"];
		expect(parseLabelSelection("1,3", choices)).toEqual([
			"chore",
			"Orchestrator",
		]);
		expect(parseLabelSelection("2, bug", choices)).toEqual(["PRD", "bug"]); // number + free name
		expect(parseLabelSelection("1,1,2", choices)).toEqual(["chore", "PRD"]); // de-duped
		expect(parseLabelSelection("9, 0, -1", choices)).toEqual([]); // out-of-range ignored
		expect(parseLabelSelection("", choices)).toEqual([]);
	});
});

describe("choreBlockReason", () => {
	it("narrates the first failing predicate (else null)", () => {
		expect(
			choreBlockReason(new Issue({ repo: "p", body: "edit a.py" }), CFG),
		).toBeNull(); // not chore-labeled
		expect(
			choreBlockReason(
				new Issue({ repo: "p", labels: ["chore"], body: "edit a.py" }),
				CFG,
			),
		).toBeNull();
		const noTarget = choreBlockReason(
			new Issue({ repo: "p", labels: ["chore"], body: "tidy things" }),
			CFG,
		);
		expect(noTarget).toContain("concrete target");
		const work = choreBlockReason(
			new Issue({
				repo: "work-monorepo",
				labels: ["chore"],
				body: "edit a.py",
			}),
			CFG,
		);
		expect(work).toContain("work repo");
		const longBody = `edit a.py ${Array(60).fill("word").join(" ")}`;
		const tooLong = choreBlockReason(
			new Issue({ repo: "p", labels: ["chore"], body: longBody }),
			CFG,
		);
		expect(tooLong).toContain("words");
	});

	it("checks work_repos before multi_repo, matching the routing decision", () => {
		// When both a work-repo AND multi_repo apply, both functions must fail on work_repos
		// first, so the narration explain() shows agrees with the actual routing decision.
		const issue = new Issue({
			repo: "work-monorepo",
			labels: ["chore"],
			body: "edit a.py",
			multi_repo: true,
		});
		expect(choreRuleFires(issue, CFG)).toBe(false);
		expect(choreBlockReason(issue, CFG)).toContain("work repo"); // not the multi-repo reason
	});
});

describe("explain", () => {
	it("includes the reuse invocation and the chore note", () => {
		const issue = new Issue({
			repo: "p",
			labels: ["chore"],
			body: "tidy things",
		});
		const text = explain(issue, route(issue, CFG), CFG);
		expect(text).toContain("reuse:");
		expect(text).toContain("uv run route");
		expect(text).toContain("not auto-approved");
		expect(text).toContain("diff_gate: manual");
	});
});

describe("issuePayload", () => {
	it("drops default fields", () => {
		expect(issuePayload(new Issue({ repo: "p" }))).toEqual({ repo: "p" });
		const full = issuePayload(
			new Issue({
				repo: "p",
				labels: ["x"],
				body: "b",
				estimate: 2,
				multi_repo: true,
			}),
		);
		expect(full).toEqual({
			repo: "p",
			labels: ["x"],
			body: "b",
			estimate: 2,
			multi_repo: true,
		});
	});
});

describe("namesConcreteTarget", () => {
	it.each<[string, boolean]>([
		["edit src/main.py", true],
		["bump left-pad@1.2.0", true],
		["set FEATURE_FLAG_X in env", true],
		["update service.timeout.ms config", true],
		["change `pubspec.yaml`", true],
		["make it nicer somehow", false],
		["refactor the whole thing", false],
		// #4 prose dependency bumps (the most common chore) — now a concrete target.
		["Bump lodash from 4.17.20 to 4.17.21", true],
		["bump left-pad to 1.2.0", true],
		// #2 Latin abbreviations must NOT count as a concrete file/config target.
		["Clean up old code, e.g. remove dead config", false],
		["Refactor the module, i.e. simplify it", false],
		["Rework the thing (a.k.a. the widget)", false],
		// #3 slash idioms must NOT count as a concrete path.
		["Update the docs and/or config, not sure which", false],
		["Handle the true/false cases better", false],
		["Mark it N/A somewhere", false],
		// regression: a real target sitting next to an idiom still counts.
		["Update and/or replace src/main.py", true],
		// #2 (impl-review): prose "<word> to/from <decimal>" must NOT forge a dependency hit.
		["Move the parsing logic to 2.0", false],
		["upgrade to 2.0", false], // a bump verb but no package token
		["reduce the retry timeout from 1.5 to 2.0", false],
		// ...but a real bump verb + package + version still counts.
		["upgrade left-pad to 1.2.0", true],
		// #7 (impl-review): a backtick literal that equals a denylisted word still counts —
		// the backtick is an explicit "this is a real token" signal.
		["clean up old cron entries in `etc`", true],
		["rewrite the launcher script `vs`", true],
	])("namesConcreteTarget(%j) === %s", (text, expected) => {
		expect(namesConcreteTarget(text)).toBe(expected);
	});

	it("CONFIG_KEY_RE has no capturing group; FILE_RE captures group 1", () => {
		// pins the m[1] !== undefined ? m[1] : m[0] branch in concreteTargets.
		const cfgMatch = [..."set FEATURE_FLAG_X now".matchAll(CONFIG_KEY_RE)][0];
		expect(cfgMatch?.[1]).toBeUndefined(); // -> whole match
		const fileMatch = [..."edit src/main.py now".matchAll(FILE_RE)][0];
		expect(fileMatch?.[1]).toBe("src/main.py"); // -> group 1
	});
});
