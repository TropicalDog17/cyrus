import type {
	AskUserQuestionAnswers,
	AskUserQuestionInput,
	AskUserQuestionResult,
	ILogger,
} from "cyrus-core";
import type { BuzzApprovalRegistry } from "./BuzzApprovalRegistry.js";
import type { BuzzCliClient } from "./BuzzCliClient.js";

export interface BuzzThreadRef {
	channelId: string;
	threadRootId: string;
}

export interface BuzzQuestionHandlerDeps {
	logger: ILogger;
	client: BuzzCliClient;
	approvals: BuzzApprovalRegistry;
	/** Channel and thread for a session, or null if it is not a Buzz session. */
	getThread(sessionId: string): BuzzThreadRef | null;
	/** How long to wait before proceeding without an answer. 0 waits forever. */
	getTimeoutMs(): number;
}

/**
 * Emoji offered per option, in order. Claude's `AskUserQuestion` caps a question
 * at four options, so four keycaps cover it; anything beyond falls back to
 * reply-only, since an option nobody can react to is worse than one clearly
 * labelled as type-it-out.
 */
const OPTION_EMOJI = ["1⃣", "2⃣", "3⃣", "4⃣"];

/** Sentinel used by the registry when a question times out. */
const TIMEOUT_VALUE = "";

/**
 * Asks a question in a Buzz thread and waits for a human.
 *
 * This is the Buzz counterpart of {@link AskUserQuestionHandler}, which is
 * hard-wired to Linear's select elicitation (it constructs a
 * `LinearActivitySink` and depends on Linear's `agentSessionPrompted` webhook to
 * deliver the answer). Rather than widen that class's seams for a second
 * platform with a different answer channel, Buzz sessions get their own
 * implementation of the same `onAskUserQuestion` contract, and EdgeWorker
 * dispatches on session identity.
 *
 * WAIT POLICY
 * -----------
 * A question does **not** park. When nobody answers within the configured
 * window the promise resolves `answered: false` with an instruction to proceed
 * on the agent's own recommendation — the same contract the Linear handler
 * returns on timeout, which the runner turns into a tool denial the model reads
 * and acts on. Cyrus never invents an answer and attributes it to a human.
 * Blocking indefinitely is reserved for the execution gate, where the cost of
 * guessing wrong is unattended code changes rather than a reversible decision.
 */
export class BuzzQuestionHandler {
	private readonly deps: BuzzQuestionHandlerDeps;

	constructor(deps: BuzzQuestionHandlerDeps) {
		this.deps = deps;
	}

	/** True when this handler owns questions for the given session. */
	handles(sessionId: string): boolean {
		return this.deps.getThread(sessionId) !== null;
	}

	async ask(
		input: AskUserQuestionInput,
		sessionId: string,
		signal: AbortSignal,
	): Promise<AskUserQuestionResult> {
		const question = input.questions?.[0];
		if (!question || input.questions.length !== 1) {
			return {
				answered: false,
				message: "Only one question at a time is supported in a Buzz thread",
			};
		}

		const thread = this.deps.getThread(sessionId);
		if (!thread) {
			return {
				answered: false,
				message: `No Buzz thread is bound to session ${sessionId}`,
			};
		}

		if (signal.aborted) {
			return { answered: false, message: "Operation was cancelled" };
		}

		const timeoutMs = this.deps.getTimeoutMs();
		const options = question.options
			.slice(0, OPTION_EMOJI.length)
			.map((option, index) => ({
				// biome-ignore lint/style/noNonNullAssertion: index is bounded by the slice above
				emoji: OPTION_EMOJI[index]!,
				value: option.label,
				label: option.label,
			}));

		let eventId: string;
		try {
			eventId = await this.deps.client.sendMessage({
				channelId: thread.channelId,
				content: renderQuestion(question, options, timeoutMs),
				replyTo: thread.threadRootId,
			});
		} catch (error) {
			return {
				answered: false,
				message: `Failed to ask in the Buzz thread: ${error instanceof Error ? error.message : String(error)}`,
			};
		}

		if (!eventId) {
			return {
				answered: false,
				message: "Buzz accepted the question but returned no event id",
			};
		}

		// Seed the reactions so answering is one tap. Best-effort: a relay that
		// refuses the seed still accepts the human's own reaction.
		await this.seedReactions(eventId, options);

		const pending = this.deps.approvals.register({
			eventId,
			channelId: thread.channelId,
			sessionId,
			kind: "question",
			options,
			...(timeoutMs > 0 ? { timeoutMs, timeoutValue: TIMEOUT_VALUE } : {}),
		});

		const onAbort = () => {
			this.deps.approvals.cancelSession(sessionId, "Session was stopped");
		};
		signal.addEventListener("abort", onAbort, { once: true });

		try {
			const resolution = await pending;

			if (resolution.via === "timeout" || resolution.value === TIMEOUT_VALUE) {
				if (signal.aborted) {
					return { answered: false, message: "Operation was cancelled" };
				}
				const minutes = Math.max(1, Math.round(timeoutMs / 60_000));
				await this.announce(
					thread,
					`No answer after ${minutes} minute(s) — going with my own recommendation. Reply any time to change course.`,
				);
				return {
					answered: false,
					message: `No response was received within ${minutes} minute(s). Proceed using your best judgment (for example, your recommended default), and ask again later if you still need the user's decision.`,
				};
			}

			const answers: AskUserQuestionAnswers = {
				[question.question]: resolution.value,
			};
			this.deps.logger.info(
				`Buzz question for ${sessionId} answered via ${resolution.via}`,
			);
			return { answered: true, answers };
		} finally {
			signal.removeEventListener("abort", onAbort);
		}
	}

	private async seedReactions(
		eventId: string,
		options: { emoji: string }[],
	): Promise<void> {
		for (const option of options) {
			try {
				await this.deps.client.addReaction({ eventId, emoji: option.emoji });
			} catch (error) {
				this.deps.logger.debug(
					`Could not seed reaction ${option.emoji} on ${eventId}: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}
	}

	private async announce(
		thread: BuzzThreadRef,
		content: string,
	): Promise<void> {
		try {
			await this.deps.client.sendMessage({
				channelId: thread.channelId,
				content,
				replyTo: thread.threadRootId,
			});
		} catch (error) {
			this.deps.logger.debug(
				`Could not post timeout notice: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}
}

function renderQuestion(
	question: AskUserQuestionInput["questions"][number],
	options: { emoji: string; label: string }[],
	timeoutMs: number,
): string {
	const lines = [`❓ **${question.question}**`, ""];

	for (const [index, option] of question.options.entries()) {
		const emoji = options[index]?.emoji;
		const bullet = emoji ? `${emoji} ` : "• ";
		lines.push(`${bullet}**${option.label}** — ${option.description}`);
	}

	lines.push("");
	if (timeoutMs > 0) {
		const minutes = Math.max(1, Math.round(timeoutMs / 60_000));
		lines.push(
			`_React to choose, or reply with your own answer. If I don't hear back in ${minutes} minute(s) I'll proceed on my own recommendation._`,
		);
	} else {
		lines.push("_React to choose, or reply with your own answer._");
	}

	return lines.join("\n");
}
