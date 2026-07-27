import type { ILogger } from "cyrus-core";

/**
 * What a pending prompt is waiting for, which decides its wait policy.
 *
 * - `gate` — the 📝/▶️ execution gate. Parks forever. A conversation must never
 *   promote itself into a code-writing session because nobody was looking.
 * - `question` — a mid-session `AskUserQuestion`. Defaults to proceeding after
 *   an announced timeout, because the agent is already working and blocking it
 *   on an absent human is more expensive than a reversible wrong guess.
 */
export type BuzzPromptKind = "gate" | "question";

export interface BuzzPromptOption {
	/** Emoji the human reacts with to choose this option. */
	emoji: string;
	/** Value handed back to the resolver. */
	value: string;
	/** Human-readable label rendered in the message body. */
	label: string;
}

export interface BuzzPromptResolution {
	value: string;
	/** How the human answered — used only for logging and thread copy. */
	via: "reaction" | "reply" | "timeout";
	/** Pubkey of the human who answered; absent on timeout. */
	actorPubkey?: string;
}

export interface RegisterBuzzPromptParams {
	/** Event id the options are attached to; reactions land here. */
	eventId: string;
	channelId: string;
	/** Cyrus session this prompt belongs to. */
	sessionId: string;
	kind: BuzzPromptKind;
	options: BuzzPromptOption[];
	/**
	 * Milliseconds before the prompt resolves itself with `via: "timeout"`.
	 * Omit (or pass 0) to wait indefinitely — the wait policy for gates.
	 */
	timeoutMs?: number;
	/** Value handed back on timeout. Required when `timeoutMs` is set. */
	timeoutValue?: string;
}

interface PendingPrompt {
	eventId: string;
	channelId: string;
	sessionId: string;
	kind: BuzzPromptKind;
	options: BuzzPromptOption[];
	settle: (resolution: BuzzPromptResolution) => void;
	timer?: ReturnType<typeof setTimeout>;
}

/**
 * Tracks Buzz messages that are waiting on a human, and resolves them when a
 * reaction or a threaded reply arrives.
 *
 * This exists because Buzz has no request/response primitive: Cyrus posts a
 * message and the answer arrives later as an unrelated event. The registry is
 * the join between the two, keyed by the event id reactions attach to.
 *
 * State is in-memory, but a gate no longer dies with the process. A gate parks
 * indefinitely and the message stays in the scrollback, so a human who reacts
 * ▶️ after a deploy has no way to tell that the reaction went nowhere — the
 * coordinator therefore persists an open gate's event id and options and
 * re-arms it on boot ({@link BuzzSessionCoordinator.hydrate}). The hazard that
 * once argued against that — a ▶️ starting work nobody is watching for — is
 * answered where it belongs: a gate decision only acts on a thread still in
 * `triage`, so a reaction re-delivered against a promoted thread is a no-op.
 *
 * A `question` is different and still dies with the process: it needs a live
 * SDK session and a caller blocked on the answer, and neither survives a
 * restart. Hydration says so in the thread instead of re-arming it.
 */
export class BuzzApprovalRegistry {
	private readonly logger: ILogger;
	/** Keyed by the event id humans react to. */
	private readonly byEventId = new Map<string, PendingPrompt>();
	/** Keyed by session id, so a reply can find its session's open prompt. */
	private readonly bySessionId = new Map<string, PendingPrompt>();

	constructor(logger: ILogger) {
		this.logger = logger;
	}

	/**
	 * Register a posted prompt and wait for it.
	 *
	 * A session may only have one open prompt: registering a second cancels the
	 * first, mirroring how the Linear handler replaces a superseded question.
	 */
	register(params: RegisterBuzzPromptParams): Promise<BuzzPromptResolution> {
		this.cancelSession(params.sessionId, "Replaced by a newer prompt");

		return new Promise<BuzzPromptResolution>((resolve) => {
			let settled = false;

			const settle = (resolution: BuzzPromptResolution) => {
				if (settled) return;
				settled = true;
				if (pending.timer) clearTimeout(pending.timer);
				this.byEventId.delete(params.eventId);
				if (this.bySessionId.get(params.sessionId) === pending) {
					this.bySessionId.delete(params.sessionId);
				}
				resolve(resolution);
			};

			const pending: PendingPrompt = {
				eventId: params.eventId,
				channelId: params.channelId,
				sessionId: params.sessionId,
				kind: params.kind,
				options: params.options,
				settle,
			};

			if (params.timeoutMs && params.timeoutMs > 0) {
				const timeoutValue = params.timeoutValue ?? "";
				pending.timer = setTimeout(() => {
					this.logger.info(
						`Buzz ${params.kind} on ${params.eventId} timed out; proceeding with "${timeoutValue}"`,
					);
					settle({ value: timeoutValue, via: "timeout" });
				}, params.timeoutMs);
				// A pending prompt must not hold the process open at shutdown.
				pending.timer.unref?.();
			}

			this.byEventId.set(params.eventId, pending);
			this.bySessionId.set(params.sessionId, pending);
		});
	}

	/**
	 * Resolve a prompt from a reaction.
	 *
	 * @returns true when the reaction matched an open prompt and settled it.
	 */
	resolveByReaction(
		eventId: string,
		emoji: string,
		actorPubkey: string,
	): boolean {
		const pending = this.byEventId.get(eventId);
		if (!pending) return false;

		const option = pending.options.find(
			(candidate) => candidate.emoji === emoji,
		);
		if (!option) {
			this.logger.debug(
				`Ignoring reaction ${emoji} on ${eventId}: not one of the offered options`,
			);
			return false;
		}

		pending.settle({ value: option.value, via: "reaction", actorPubkey });
		return true;
	}

	/**
	 * Resolve a session's open prompt from a threaded reply.
	 *
	 * Free text wins over the offered options: a human who types "use the other
	 * repo instead" is answering, and forcing them onto a reaction would drop
	 * what they said. Gates are the exception — an execution gate is a yes/no
	 * that must be deliberate, so prose does not open it.
	 */
	resolveByReply(
		sessionId: string,
		text: string,
		actorPubkey: string,
	): boolean {
		const pending = this.bySessionId.get(sessionId);
		if (!pending) return false;

		const trimmed = text.trim();
		if (!trimmed) return false;

		const matched = pending.options.find(
			(option) => option.label.toLowerCase() === trimmed.toLowerCase(),
		);

		if (pending.kind === "gate" && !matched) {
			return false;
		}

		pending.settle({
			value: matched ? matched.value : trimmed,
			via: "reply",
			actorPubkey,
		});
		return true;
	}

	/** Event ids with an open prompt, for the poller to check reactions on. */
	pendingEventIds(): string[] {
		return [...this.byEventId.keys()];
	}

	/**
	 * A session's open prompt, in the shape a boot re-arm needs.
	 *
	 * The registry is the only place that knows what is actually open, so
	 * persistence reads it here rather than keeping a second copy alongside the
	 * thread — a copy that could disagree about whether a prompt is still live.
	 */
	openPromptFor(sessionId: string):
		| {
				eventId: string;
				channelId: string;
				kind: BuzzPromptKind;
				options: BuzzPromptOption[];
		  }
		| undefined {
		const pending = this.bySessionId.get(sessionId);
		if (!pending) return undefined;

		return {
			eventId: pending.eventId,
			channelId: pending.channelId,
			kind: pending.kind,
			options: pending.options,
		};
	}

	hasPendingPrompt(sessionId: string): boolean {
		return this.bySessionId.has(sessionId);
	}

	/** Settle a session's open prompt as a timeout, e.g. when it is torn down. */
	cancelSession(sessionId: string, reason: string): void {
		const pending = this.bySessionId.get(sessionId);
		if (!pending) return;

		this.logger.debug(
			`Cancelling Buzz ${pending.kind} for session ${sessionId}: ${reason}`,
		);
		pending.settle({ value: "", via: "timeout" });
	}
}
