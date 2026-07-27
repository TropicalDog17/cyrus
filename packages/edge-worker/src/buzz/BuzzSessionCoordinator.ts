import type { BuzzWebhookEvent } from "cyrus-buzz-event-transport";
import type {
	BuzzChannelRoute,
	ILogger,
	PersistedBuzzThread,
	PersistedBuzzWorkUnit,
	RepositoryConfig,
	SerializableEdgeWorkerState,
} from "cyrus-core";
import type { AgentSessionManager } from "../AgentSessionManager.js";
import type {
	BuzzSessionPhase,
	SessionOrchestrator,
} from "../SessionOrchestrator.js";
import type { IActivitySink } from "../sinks/IActivitySink.js";
import type {
	BuzzApprovalRegistry,
	BuzzPromptOption,
} from "./BuzzApprovalRegistry.js";
import type { BuzzCliClient, BuzzEventRecord } from "./BuzzCliClient.js";
import type { BuzzThreadRef } from "./BuzzQuestionHandler.js";

/** What the human chose at the execution gate. */
export type BuzzGateDecision = "implement" | "track";

export interface BuzzTrackRequest {
	sessionId: string;
	sessionKey: string;
	channelId: string;
	threadRootId: string;
	title: string;
	/** The message that opened the thread, as the description to track. */
	summary: string;
	repository: RepositoryConfig;
}

export interface BuzzSessionCoordinatorDeps {
	logger: ILogger;
	client: BuzzCliClient;
	agentSessionManager: AgentSessionManager;
	sessionOrchestrator: SessionOrchestrator;
	approvals: BuzzApprovalRegistry;
	/** Channel-to-repository routes from `config.buzz.channels`. */
	getChannelRoutes(): BuzzChannelRoute[];
	/**
	 * Cyrus's own Nostr pubkey, used to recognize an @mention. Undefined
	 * disables catch-all channels entirely — see {@link isAddressedToCyrus}.
	 */
	getSelfPubkey(): string | undefined;
	getRepositoryById(repositoryId: string): RepositoryConfig | undefined;
	/**
	 * Write EdgeWorker state to disk. A turn saves at both ends on its own; this
	 * is for the gate, which is armed after the turn that offered it returned.
	 */
	saveState(): Promise<void>;
	/** Sink bound to a channel; one per channel, created lazily by EdgeWorker. */
	getActivitySinkForChannel(channelId: string): IActivitySink;
	/**
	 * Issue-tracker projection. Optional so the gate works with no tracker
	 * configured; {@link BuzzLinearProjection} supplies it.
	 */
	projection?: BuzzProjectionHooks;
}

/**
 * The slice of an issue tracker the gate needs. Narrow on purpose: the
 * coordinator decides *when* work is worth recording, and knows nothing about
 * which tracker records it.
 */
export interface BuzzProjectionHooks {
	/** Create the tracking issue. Returns its identifier, or null. */
	track(request: BuzzTrackRequest): Promise<string | null>;
	/** Append a comment to a tracked thread's issue. */
	note(sessionId: string, body: string): Promise<void>;
	/** Move a tracked thread's issue to a workflow state by name. */
	setState(sessionId: string, stateName: string): Promise<void>;
	/** The issue projected for a thread, if any — read to persist it. */
	get(sessionId: string): BuzzProjectedProgram | undefined;
	/** Re-seed a hydrated thread's projection so no second issue is created. */
	restore(
		sessionId: string,
		program: BuzzProjectedProgram,
		repository: RepositoryConfig,
	): void;
}

/** A thread's projected program issue, as persisted and rehydrated. */
export interface BuzzProjectedProgram {
	issueId: string;
	identifier: string;
	url: string;
}

/**
 * Number of hex characters of the thread root that name a Buzz session. Six
 * gives ~16.7M values, which is far beyond the number of live conversations a
 * deployment has, while staying short enough to read in a branch name.
 */
const SESSION_KEY_LENGTH = 6;

/** How many delivery ids to remember for duplicate suppression. */
const MAX_SEEN_DELIVERIES = 500;

const GATE_IMPLEMENT_EMOJI = "▶️";
const GATE_TRACK_EMOJI = "📝";

/**
 * The gate's reactable options. A module constant because a re-armed gate must
 * offer exactly what the posted message says it offers, and the message it
 * belongs to was written by an earlier process.
 */
const GATE_OPTIONS: BuzzPromptOption[] = [
	{ emoji: GATE_IMPLEMENT_EMOJI, value: "implement", label: "implement" },
	{ emoji: GATE_TRACK_EMOJI, value: "track", label: "track" },
];

/** Channel id that matches any channel without a route of its own. */
export const CATCH_ALL_CHANNEL = "*";

/** Reactable option markers, shared with {@link BuzzQuestionHandler}. */
const OPTION_EMOJI = ["1⃣", "2⃣", "3⃣", "4⃣"];

/** Everything Cyrus needs to run another phase of an existing Buzz thread. */
interface BuzzThreadContext {
	sessionId: string;
	channelId: string;
	threadRootId: string;
	sessionKey: string;
	branchName: string;
	title: string;
	repository: RepositoryConfig;
	workspace: { path: string; isGitWorktree: boolean };
	phase: BuzzSessionPhase;
	/** Agent-side session id of the last completed run, for resuming it. */
	agentSessionId?: string;
	/** First human message in the thread, kept for the tracked-issue body. */
	openingMessage: string;
	/** Latest response Cyrus posted, used as the projected issue's summary. */
	lastResponse?: string;
	/** Epoch ms of the thread's last turn, which orders {@link repoMru}. */
	lastUsedAt: number;
	/** The thread's program issue, once the gate projected one. */
	program?: BuzzProjectedProgram;
	/**
	 * The program's work units and the plan they came from.
	 *
	 * Carried verbatim through hydrate and serialize even though nothing writes
	 * them yet: a boot that dropped them would erase a plan the operator had
	 * already approved, and a record that only survives one restart is worse than
	 * none.
	 */
	workUnits: PersistedBuzzWorkUnit[];
	plan?: PersistedBuzzThread["plan"];
}

/** Buzz thread state as persisted, the argument {@link hydrate} takes. */
type PersistedBuzzState = NonNullable<SerializableEdgeWorkerState["buzz"]>;

/**
 * Turns a Buzz trigger into a Cyrus session, and mediates the execution gate.
 *
 * Session identity is synthesized, not refactored: a Buzz thread mints a
 * `BUZZ-a1b2c3` identifier from its root event id, exactly as a GitHub PR
 * mints `PR-123`. Nothing downstream — worktree naming, branch naming, session
 * state — needs to know that no issue tracker is involved.
 *
 * The thread root, not the triggering message, is the durable identity: every
 * follow-up message in the same thread resumes the same session.
 *
 * WHO CYRUS ANSWERS
 * -----------------
 * A channel with a route of its own is a Cyrus channel and any allowlisted
 * human's message opens a thread. A channel reached only through the `"*"`
 * catch-all route is a shared room, and it takes an @mention — see
 * {@link mayOpenThread}.
 *
 * THE EXECUTION GATE
 * ------------------
 * A thread always starts in `triage`, where the agent can read the repository
 * and answer but cannot modify it. When the turn ends Cyrus posts a gate
 * message and waits, indefinitely, for an allowlisted human to react ▶️
 * (implement) or 📝 (track only). Only ▶️ promotes the thread to `execute`,
 * where the repository's full tool set applies. Chat therefore never
 * self-promotes into code changes because a conversation drifted that way.
 *
 * The gate is enforced by the tool set, not by prompt wording — see
 * {@link SessionOrchestrator.startBuzzSession}.
 *
 * SURVIVING A RESTART
 * -------------------
 * A Buzz thread's identity is synthesized rather than read back from an issue
 * tracker, so nothing outside the state file can reconstruct it: without
 * {@link serialize} and {@link hydrate} a deploy loses the thread's phase, its
 * program issue and the worktree its branch lives in. Hydration is deliberately
 * lossy in one direction only — an unrecognized phase reverts to `triage` and a
 * lost question is announced — because redoing a round trip is recoverable and a
 * thread nothing can advance is not.
 */
export class BuzzSessionCoordinator {
	private readonly deps: BuzzSessionCoordinatorDeps;
	private readonly seenDeliveries = new Set<string>();
	private readonly threads = new Map<string, BuzzThreadContext>();
	/** Per-session serialization, so a burst of messages cannot race. */
	private readonly queues = new Map<string, Promise<void>>();

	constructor(deps: BuzzSessionCoordinatorDeps) {
		this.deps = deps;
	}

	/** Channel and thread bound to a session, for the question handler. */
	getThread(sessionId: string): BuzzThreadRef | null {
		const context = this.threads.get(sessionId);
		if (!context) return null;
		return {
			channelId: context.channelId,
			threadRootId: context.threadRootId,
		};
	}

	/**
	 * Buzz thread state for the EdgeWorker state file.
	 *
	 * The per-session queues are deliberately absent — a promise chain is not
	 * state — and so is the delivery cache: forgetting which deliveries were seen
	 * makes a restart re-read its polling window, which is the at-least-once path
	 * the gate's phase guard already has to survive.
	 *
	 * An open prompt is read back from the approval registry rather than tracked
	 * here, so persistence cannot disagree with the registry about what is live.
	 */
	serialize(): PersistedBuzzState {
		const threads: Record<string, PersistedBuzzThread> = {};

		for (const [sessionId, context] of this.threads) {
			const openPrompt = this.deps.approvals.openPromptFor(sessionId);
			threads[sessionId] = {
				channelId: context.channelId,
				threadRootId: context.threadRootId,
				sessionKey: context.sessionKey,
				title: context.title,
				repositoryId: context.repository.id,
				branchName: context.branchName,
				// Field by field: whatever else a provisioned workspace carries, the
				// record is the contract a hydrated turn runs against.
				workspace: {
					path: context.workspace.path,
					isGitWorktree: context.workspace.isGitWorktree,
				},
				phase: context.phase,
				openingMessage: context.openingMessage,
				...(context.lastResponse !== undefined
					? { lastResponse: context.lastResponse }
					: {}),
				...(context.agentSessionId
					? { agentSessionId: context.agentSessionId }
					: {}),
				lastUsedAt: context.lastUsedAt,
				...(context.program ? { program: context.program } : {}),
				workUnits: context.workUnits,
				...(context.plan ? { plan: context.plan } : {}),
				...(openPrompt ? { openPrompt } : {}),
			};
		}

		return { threads, repoMru: this.repoMru() };
	}

	/**
	 * Restore threads from the state file, and deal with whatever each one was
	 * waiting on.
	 *
	 * A thread whose repository has left the configuration is dropped rather than
	 * kept: its worktree is no longer reachable, so there is no turn to run in it.
	 */
	async hydrate(state: SerializableEdgeWorkerState["buzz"]): Promise<void> {
		// A pre-v5 state file is migrated to a present-but-empty container, so a
		// missing `buzz` and an empty one mean the same thing.
		const persisted = Object.entries(state?.threads ?? {});
		if (persisted.length === 0) return;

		let restored = 0;
		for (const [sessionId, thread] of persisted) {
			const repository = this.deps.getRepositoryById(thread.repositoryId);
			if (!repository) {
				this.deps.logger.warn(
					`Dropping Buzz thread ${thread.sessionKey}: repository "${thread.repositoryId}" is no longer configured`,
				);
				continue;
			}

			const context: BuzzThreadContext = {
				sessionId,
				channelId: thread.channelId,
				threadRootId: thread.threadRootId,
				sessionKey: thread.sessionKey,
				branchName: thread.branchName,
				title: thread.title,
				repository,
				workspace: thread.workspace,
				phase: hydratePhase(thread.phase),
				openingMessage: thread.openingMessage,
				...(thread.lastResponse !== undefined
					? { lastResponse: thread.lastResponse }
					: {}),
				...(thread.agentSessionId
					? { agentSessionId: thread.agentSessionId }
					: {}),
				lastUsedAt: thread.lastUsedAt,
				...(thread.program ? { program: thread.program } : {}),
				workUnits: thread.workUnits,
				...(thread.plan ? { plan: thread.plan } : {}),
			};
			this.threads.set(sessionId, context);
			restored++;

			if (thread.program) {
				this.deps.projection?.restore(sessionId, thread.program, repository);
			}

			await this.resumePrompt(context, thread.openPrompt);
		}

		this.deps.logger.info(`Restored ${restored} Buzz thread(s)`);
	}

	/**
	 * Deal with the prompt a hydrated thread was parked on.
	 *
	 * A gate is re-armed against the event id humans have already reacted to, and
	 * not re-posted: the scrollback shows the question as asked, and asking twice
	 * reads as Cyrus having forgotten. A question cannot be re-armed at all —
	 * `AskUserQuestion` needs the SDK session and the blocked caller the restart
	 * took with it — so it dies, out loud, because silence there is
	 * indistinguishable from Cyrus ignoring an answer that was already given.
	 * Nothing clears it explicitly: an unarmed prompt is not in the registry, so
	 * the next save does not carry it.
	 */
	private async resumePrompt(
		context: BuzzThreadContext,
		openPrompt: PersistedBuzzThread["openPrompt"],
	): Promise<void> {
		if (!openPrompt) return;

		if (openPrompt.kind === "gate") {
			this.armGate(context, openPrompt);
			return;
		}

		await this.say(
			context,
			"⚠️ I restarted while waiting on your answer, so the question above is lost. Say what you'd like again and I'll pick it up from there.",
		);
	}

	/**
	 * Repository ids, most recently worked on first.
	 *
	 * Derived from the threads rather than tracked alongside them: a list kept in
	 * parallel can disagree with the threads it summarizes, and `lastUsedAt`
	 * already carries everything the order needs.
	 */
	private repoMru(): string[] {
		const newest = new Map<string, number>();
		for (const context of this.threads.values()) {
			const previous = newest.get(context.repository.id) ?? 0;
			if (context.lastUsedAt > previous) {
				newest.set(context.repository.id, context.lastUsedAt);
			}
		}

		return [...newest.entries()]
			.sort(([, a], [, b]) => b - a)
			.map(([repositoryId]) => repositoryId);
	}

	async handleEvent(event: BuzzWebhookEvent): Promise<void> {
		const { logger } = this.deps;

		if (this.isDuplicate(event.deliveryId)) {
			logger.debug(`Ignoring duplicate Buzz delivery ${event.deliveryId}`);
			return;
		}

		if (event.eventType === "reaction_added") {
			this.handleReaction(event);
			return;
		}

		// A channel with no route at all is somebody else's channel. Checking that
		// before reading the message keeps Cyrus from touching the relay — and
		// from paying attention — for traffic it will never act on.
		if (this.routesForChannel(event.channelId).length === 0) {
			logger.debug(
				`No repository routed for Buzz channel ${event.channelId}; ignoring`,
			);
			return;
		}

		const message = await this.fetchMessage(event);
		if (!message) return;

		const prompt = message.content.trim();
		if (!prompt) {
			logger.debug(`Buzz event ${event.messageId} has no text; ignoring`);
			return;
		}

		const threadRootId = threadRootOf(message);
		const sessionId = `buzz-${threadRootId}`;

		// A reply in a thread whose session is waiting on an answer *is* the
		// answer. Routing it to a new turn instead would leave the runner
		// blocked on a question the human has already answered.
		if (
			this.deps.approvals.resolveByReply(sessionId, prompt, event.authorPubkey)
		) {
			logger.info(`Buzz reply answered the open prompt for ${sessionId}`);
			return;
		}

		const existingThread = this.threads.get(sessionId);
		if (!existingThread && !this.mayOpenThread(event.channelId, message)) {
			logger.debug(
				`Buzz message ${event.messageId} in shared channel ${event.channelId} does not mention Cyrus; ignoring`,
			);
			return;
		}

		const repository = existingThread
			? existingThread.repository
			: await this.chooseRepository(event, sessionId, threadRootId);
		if (!repository) return;

		await this.enqueue(sessionId, async () => {
			const existing = this.threads.get(sessionId);
			if (existing) {
				await this.runTurn(existing, prompt);
				return;
			}
			await this.startThread(
				sessionId,
				threadRootId,
				prompt,
				repository,
				event,
			);
		});
	}

	/**
	 * Reactions are only ever answers to something Cyrus asked. An emoji on any
	 * other message is ordinary chat and must not reach a runner — otherwise a
	 * thumbs-up on a colleague's message would start a coding session.
	 */
	private handleReaction(event: BuzzWebhookEvent): void {
		if (!event.emoji) return;

		const resolved = this.deps.approvals.resolveByReaction(
			event.messageId,
			event.emoji,
			event.authorPubkey,
		);

		if (!resolved) {
			this.deps.logger.debug(
				`Buzz reaction ${event.emoji} on ${event.messageId} matched no open prompt; ignoring`,
			);
		}
	}

	private async fetchMessage(
		event: BuzzWebhookEvent,
	): Promise<BuzzEventRecord | null> {
		try {
			const message = await this.deps.client.getEvent({
				channelId: event.channelId,
				eventId: event.messageId,
			});
			if (!message) {
				this.deps.logger.warn(
					`Buzz event ${event.messageId} was not found on the relay`,
				);
			}
			return message;
		} catch (error) {
			this.deps.logger.error(
				`Failed to read Buzz event ${event.messageId}`,
				error instanceof Error ? error : new Error(String(error)),
			);
			return null;
		}
	}

	private async startThread(
		sessionId: string,
		threadRootId: string,
		prompt: string,
		repository: RepositoryConfig,
		event: BuzzWebhookEvent,
	): Promise<void> {
		const sessionKey = `BUZZ-${threadRootId.slice(0, SESSION_KEY_LENGTH)}`;
		const title = firstLine(prompt);
		const branchName = `${sessionKey}-${slugify(title)}`;

		const workspace = await this.deps.sessionOrchestrator.createBuzzWorkspace(
			repository,
			sessionKey,
			branchName,
			title,
		);
		if (!workspace) {
			this.deps.logger.error(
				`Could not create a workspace for Buzz session ${sessionKey}`,
			);
			return;
		}

		this.deps.logger.info(
			`Starting Buzz session ${sessionKey} on ${repository.name} (channel ${event.channelId})`,
		);

		const context: BuzzThreadContext = {
			sessionId,
			channelId: event.channelId,
			threadRootId,
			sessionKey,
			branchName,
			title,
			repository,
			workspace,
			phase: "triage",
			openingMessage: prompt,
			lastUsedAt: Date.now(),
			workUnits: [],
		};
		this.threads.set(sessionId, context);

		await this.runTurn(context, prompt);
	}

	/**
	 * Run one turn in the thread's current phase, then — while still in triage —
	 * offer the gate.
	 *
	 * Follow-up turns deliberately go back through `startBuzzSession` rather than
	 * the generic resume path: resuming re-derives the tool set from the
	 * repository config, which would hand a triage thread write access on its
	 * second message and quietly defeat the gate.
	 */
	private async runTurn(
		context: BuzzThreadContext,
		prompt: string,
	): Promise<void> {
		context.lastUsedAt = Date.now();

		const agentSessionId = await this.deps.sessionOrchestrator.startBuzzSession(
			{
				repository: context.repository,
				workspace: context.workspace,
				sessionId: context.sessionId,
				sessionKey: context.sessionKey,
				threadRootId: context.threadRootId,
				branchName: context.branchName,
				title: context.title,
				taskInstructions: `${scopePreamble(context.repository)}\n\n${prompt}`,
				activitySink: this.deps.getActivitySinkForChannel(context.channelId),
				phase: context.phase,
				...(context.agentSessionId
					? { resumeSessionId: context.agentSessionId }
					: {}),
			},
		);

		if (agentSessionId) {
			context.agentSessionId = agentSessionId;
		}

		if (context.phase === "triage") {
			await this.offerGate(context);
		}
	}

	/**
	 * Post the gate and wait for a human. This never times out: an unanswered
	 * gate leaves the thread in triage, which is the safe resting state.
	 */
	private async offerGate(context: BuzzThreadContext): Promise<void> {
		let eventId: string;
		try {
			eventId = await this.deps.client.sendMessage({
				channelId: context.channelId,
				content: [
					`${GATE_IMPLEMENT_EMOJI} implement this — I'll write code on \`${context.branchName}\``,
					`${GATE_TRACK_EMOJI} just track it — no code changes`,
					"",
					"_React to choose. I'll stay read-only until you do._",
				].join("\n"),
				replyTo: context.threadRootId,
			});
		} catch (error) {
			this.deps.logger.error(
				`Could not post the execution gate for ${context.sessionKey}`,
				error instanceof Error ? error : new Error(String(error)),
			);
			return;
		}
		if (!eventId) return;

		await this.seedGateReactions(eventId);

		this.armGate(context, {
			eventId,
			channelId: context.channelId,
			options: GATE_OPTIONS,
		});

		// A parked thread is the one state nothing else writes: the turn that
		// offered this gate has already saved at both ends, and the next turn only
		// happens once the gate resolves. Without a save here the gate exists in
		// memory only, and a boot would have nothing to re-arm from.
		await this.deps.saveState();
	}

	/**
	 * Wait for a gate's answer and act on it.
	 *
	 * Split out of {@link offerGate} because a boot re-arms a gate whose message
	 * was posted by an earlier process: registering the prompt without this wait
	 * would leave a gate that records reactions and does nothing with them.
	 */
	private armGate(
		context: BuzzThreadContext,
		prompt: { eventId: string; channelId: string; options: BuzzPromptOption[] },
	): void {
		const pending = this.deps.approvals.register({
			eventId: prompt.eventId,
			channelId: prompt.channelId,
			sessionId: context.sessionId,
			kind: "gate",
			options: prompt.options,
		});

		// Deliberately not awaited inside the queued turn. A gate can stay open
		// for hours, and the per-session queue must stay free in the meantime so
		// the human's next message still reaches the thread — including a message
		// that supersedes the gate entirely.
		void pending
			.then((resolution) => {
				if (resolution.via === "timeout") {
					// Reached when the gate is superseded or the session is torn
					// down; the gate itself never expires. Leaving the thread in
					// triage is the correct resting state.
					return undefined;
				}
				return this.enqueue(context.sessionId, () =>
					this.applyGateDecision(context, resolution.value as BuzzGateDecision),
				);
			})
			.catch((error: unknown) => {
				this.deps.logger.error(
					`Buzz gate handling failed for ${context.sessionKey}`,
					error instanceof Error ? error : new Error(String(error)),
				);
			});
	}

	/**
	 * Act on the gate. Both answers project an issue: the gate is the moment a
	 * conversation becomes a piece of work worth a durable record, whether or not
	 * anybody writes code for it.
	 */
	private async applyGateDecision(
		context: BuzzThreadContext,
		decision: BuzzGateDecision,
	): Promise<void> {
		// A gate only means anything while the thread is still waiting to be let
		// out of triage. Reactions arrive at least once — a gate re-armed on boot
		// is live again with an empty reaction cache, so the ▶️ a human pressed
		// before the deploy re-delivers — and a second pass here would start a
		// second implementation turn against the same branch. Logged, not posted:
		// the human did nothing wrong and the thread is already moving.
		if (context.phase !== "triage") {
			this.deps.logger.info(
				`Ignoring a gate decision for ${context.sessionKey}: the thread is already in the ${context.phase} phase`,
			);
			return;
		}

		const identifier = await this.deps.projection?.track({
			sessionId: context.sessionId,
			sessionKey: context.sessionKey,
			channelId: context.channelId,
			threadRootId: context.threadRootId,
			title: context.title,
			summary: context.openingMessage,
			repository: context.repository,
		});

		// A repository with no `teamKeys` cannot be projected at all, and the
		// projection has no way to say so — it writes to Linear or nowhere. Left
		// to a log line, a whole program silently does not exist while the human
		// carries on believing it does. Only when `teamKeys` is the reason: a
		// Linear outage also returns null, and telling somebody to fix their
		// config over a 503 would be a lie.
		if (
			this.deps.projection &&
			!identifier &&
			!context.repository.teamKeys?.length
		) {
			await this.say(
				context,
				`⚠️ I can't record this in Linear: the \`${context.repository.name}\` repository has no \`teamKeys\` configured.`,
			);
		}

		// Keep the issue itself, not just its key: a restart that could not find
		// the program issue would project a second one for the same thread.
		const projected = this.deps.projection?.get(context.sessionId);
		if (projected) {
			context.program = {
				issueId: projected.issueId,
				identifier: projected.identifier,
				url: projected.url,
			};
		}

		if (decision === "implement") {
			context.phase = "execute";
		}

		// Answering the gate is the transition the state file most needs and is
		// least likely to get: the gate parked, so its record on disk still says
		// the gate is open and carries no program issue. `track` returns from
		// here without ever running a turn, and `implement` only saves inside
		// `runTurn`, after several awaited relay and Linear round trips. Without
		// a save right here, a restart in between re-arms an answered gate, the
		// reaction the human already pressed re-delivers, and the projection —
		// with no persisted program to restore — creates a *second* program issue
		// for the same thread. Saving before either branch closes both windows.
		await this.deps.saveState();

		if (decision === "track") {
			this.deps.logger.info(
				`Buzz thread ${context.sessionKey} tracked without implementation`,
			);
			await this.say(
				context,
				identifier
					? `📝 Tracked as **${identifier}**. I won't make any changes.`
					: "📝 Noted — I won't make any changes.",
			);
			return;
		}

		this.deps.logger.info(
			`Buzz thread ${context.sessionKey} approved for implementation`,
		);

		if (identifier) {
			await this.say(context, `▶️ On it — tracking as **${identifier}**.`);
			await this.deps.projection?.setState(context.sessionId, "In Progress");
			await this.deps.projection?.note(
				context.sessionId,
				`Working on branch \`${context.branchName}\` in \`${context.repository.name}\`.`,
			);
		}

		// Already inside the per-session queue; enqueueing again would wait on the
		// task that is running this line.
		await this.runTurn(
			context,
			`The change above is approved. Implement it now on branch \`${context.branchName}\`, then summarise what you changed.`,
		);

		if (identifier) {
			await this.deps.projection?.note(
				context.sessionId,
				context.lastResponse
					? `**Summary from the Buzz thread**\n\n${context.lastResponse}`
					: "The implementation run finished without posting a summary.",
			);
			await this.deps.projection?.setState(context.sessionId, "In Review");
		}
	}

	/** Record the latest response Cyrus posted, for the projection's summary. */
	recordResponse(threadRootId: string, body: string): void {
		const context = this.threads.get(`buzz-${threadRootId}`);
		if (context) context.lastResponse = body;
	}

	private async say(
		context: BuzzThreadContext,
		content: string,
	): Promise<void> {
		try {
			await this.deps.client.sendMessage({
				channelId: context.channelId,
				content,
				replyTo: context.threadRootId,
			});
		} catch (error) {
			this.deps.logger.debug(
				`Could not post gate acknowledgement: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	private async seedGateReactions(eventId: string): Promise<void> {
		for (const emoji of [GATE_IMPLEMENT_EMOJI, GATE_TRACK_EMOJI]) {
			try {
				await this.deps.client.addReaction({ eventId, emoji });
			} catch (error) {
				this.deps.logger.debug(
					`Could not seed gate reaction ${emoji}: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}
	}

	/**
	 * Routes that apply to a channel: its own if it has any, otherwise the
	 * catch-all. An exact route always wins, so adding a catch-all cannot
	 * silently widen a channel that was already pinned to one repository.
	 */
	/**
	 * Whether a message is allowed to open a new thread in this channel.
	 *
	 * A channel with a route of its own is Cyrus's room: anything an allowlisted
	 * human says there is addressed to Cyrus, as it was before catch-all routing
	 * existed. A channel reached only through the catch-all route is somebody
	 * else's room that Cyrus is merely a member of, so it takes an explicit
	 * @mention — otherwise ordinary chatter anywhere in the workspace would open
	 * a session and spend tokens.
	 *
	 * Follow-ups inside a thread Cyrus already owns never reach this check: the
	 * caller consults it only when no session exists for the thread.
	 */
	private mayOpenThread(channelId: string, message: BuzzEventRecord): boolean {
		const hasOwnRoute = this.deps
			.getChannelRoutes()
			.some((route) => route.channelId === channelId);
		return hasOwnRoute || this.isAddressedToCyrus(message);
	}

	/**
	 * True when the message names Cyrus in a `p` tag — what a Buzz client writes
	 * when a human picks Cyrus out of @mention autocomplete.
	 *
	 * Matching the tag rather than the message text means a renamed profile, or
	 * the literal string "@cyrus" quoted in prose, never decides whether a
	 * session starts.
	 *
	 * Fails closed when no self pubkey is configured: with no way to recognize a
	 * mention, a catch-all deployment would otherwise treat every message in
	 * every channel as addressed to it.
	 */
	private isAddressedToCyrus(message: BuzzEventRecord): boolean {
		const self = this.deps.getSelfPubkey()?.trim().toLowerCase();
		if (!self) return false;

		return message.tags.some(
			(tag) => tag[0] === "p" && tag[1]?.trim().toLowerCase() === self,
		);
	}

	private routesForChannel(channelId: string): BuzzChannelRoute[] {
		const all = this.deps.getChannelRoutes();
		const exact = all.filter((route) => route.channelId === channelId);
		return exact.length > 0
			? exact
			: all.filter((route) => route.channelId === CATCH_ALL_CHANNEL);
	}

	private repositoriesForChannel(channelId: string): RepositoryConfig[] {
		const ids = this.routesForChannel(channelId).flatMap((route) => [
			...(route.repositoryId ? [route.repositoryId] : []),
			...(route.repositoryIds ?? []),
		]);

		const resolved: RepositoryConfig[] = [];
		for (const id of new Set(ids)) {
			const repository = this.deps.getRepositoryById(id);
			if (!repository) {
				this.deps.logger.warn(
					`Buzz channel ${channelId} routes to unknown repository "${id}"`,
				);
				continue;
			}
			resolved.push(repository);
		}
		return resolved;
	}

	/**
	 * Pick the repository a new thread runs against, asking when the channel does
	 * not determine it.
	 *
	 * A triage channel — or a DM, whose channel id cannot be configured in
	 * advance — is deliberately allowed to reach several repositories. Guessing
	 * would mean creating a worktree and reading the wrong codebase, which is
	 * slower and more confusing than a single question.
	 */
	private async chooseRepository(
		event: BuzzWebhookEvent,
		sessionId: string,
		threadRootId: string,
	): Promise<RepositoryConfig | undefined> {
		const candidates = this.repositoriesForChannel(event.channelId);

		if (candidates.length === 0) {
			this.deps.logger.warn(
				`Buzz channel ${event.channelId} has a route but no resolvable repository`,
			);
			return undefined;
		}
		if (candidates.length === 1) return candidates[0];

		const options = candidates
			.slice(0, OPTION_EMOJI.length)
			.map((repository, index) => ({
				// biome-ignore lint/style/noNonNullAssertion: index is bounded by the slice
				emoji: OPTION_EMOJI[index]!,
				value: repository.id,
				label: repository.name,
			}));

		let eventId: string;
		try {
			eventId = await this.deps.client.sendMessage({
				channelId: event.channelId,
				content: [
					"❓ **Which repository should I work in?**",
					"",
					...options.map((option) => `${option.emoji} ${option.label}`),
					"",
					"_React to choose, or reply with the repository name._",
				].join("\n"),
				replyTo: threadRootId,
			});
		} catch (error) {
			this.deps.logger.error(
				`Could not ask which repository to use in ${event.channelId}`,
				error instanceof Error ? error : new Error(String(error)),
			);
			return undefined;
		}
		if (!eventId) return undefined;

		for (const option of options) {
			try {
				await this.deps.client.addReaction({ eventId, emoji: option.emoji });
			} catch {
				// Best-effort seeding; the human can still react themselves.
			}
		}

		const resolution = await this.deps.approvals.register({
			eventId,
			channelId: event.channelId,
			sessionId,
			kind: "question",
			options,
		});

		if (resolution.via === "timeout") return undefined;

		// A reply may name the repository rather than match an option exactly.
		const chosen =
			candidates.find((repository) => repository.id === resolution.value) ??
			candidates.find(
				(repository) =>
					repository.name.toLowerCase() ===
					resolution.value.trim().toLowerCase(),
			);

		if (!chosen) {
			this.deps.logger.warn(
				`Buzz repository answer "${resolution.value}" matched no candidate`,
			);
			await this.deps.client
				.sendMessage({
					channelId: event.channelId,
					content: `I don't have a repository called "${resolution.value}". Say the message again and pick one of the options.`,
					replyTo: threadRootId,
				})
				.catch(() => undefined);
		}
		return chosen;
	}

	/**
	 * Serialize work per session. Polling can deliver several messages from one
	 * tick, and two concurrent runners against the same worktree would interleave
	 * writes. The gate's own wait runs inside a queued task, so a follow-up
	 * message while a gate is open lands after it resolves.
	 */
	private enqueue(sessionId: string, task: () => Promise<void>): Promise<void> {
		const previous = this.queues.get(sessionId) ?? Promise.resolve();
		const next = previous.then(task).catch((error) => {
			this.deps.logger.error(
				`Buzz session ${sessionId} task failed`,
				error instanceof Error ? error : new Error(String(error)),
			);
		});
		this.queues.set(sessionId, next);
		return next;
	}

	/**
	 * buzz-workflow retries a `call_webhook` step that does not return 2xx
	 * promptly, and the polling ingress re-reads an inclusive `--since` window,
	 * so the same event can arrive twice either way. Without this, the second
	 * delivery would start a duplicate runner against the same worktree.
	 */
	private isDuplicate(deliveryId: string): boolean {
		if (this.seenDeliveries.has(deliveryId)) return true;

		this.seenDeliveries.add(deliveryId);
		if (this.seenDeliveries.size > MAX_SEEN_DELIVERIES) {
			const oldest = this.seenDeliveries.values().next().value;
			if (oldest !== undefined) this.seenDeliveries.delete(oldest);
		}
		return false;
	}
}

/**
 * Resolve the NIP-10 thread root of an event: the `root`-marked `e` tag if
 * present, else a `reply`-marked one (a direct reply's parent *is* the root),
 * else the event itself. Mirrors buzz-cli's own `find_root_from_tags`, which
 * is internal to the Rust crate and not exposed as a subcommand.
 */
export function threadRootOf(event: BuzzEventRecord): string {
	let root: string | undefined;
	let reply: string | undefined;

	for (const tag of event.tags ?? []) {
		if (tag[0] !== "e" || tag.length < 4) continue;
		const id = tag[1];
		if (!id || !/^[0-9a-f]{64}$/.test(id)) continue;
		if (tag[3] === "root") root = id;
		else if (tag[3] === "reply") reply = id;
	}

	return root ?? reply ?? event.id;
}

/**
 * States the repository a thread is bound to, and the Linear scope that comes
 * with it, ahead of the human's message.
 *
 * A Buzz channel route picks exactly one repository, but the session still gets
 * the full Linear MCP catalog — so without this, "look at the current issue"
 * can land on an issue belonging to some *other* repository's project. The
 * agent then either invents the files or, correctly but unhelpfully, reports
 * that it cannot find them. Naming the scope up front is what makes the
 * repository binding visible to the model instead of only to the router.
 *
 * Emitted on every turn rather than once per thread: it is a few lines, and a
 * resumed or compacted transcript must not be the reason write access arrives
 * without its scope.
 */
function scopePreamble(repository: RepositoryConfig): string {
	const lines = [
		"<session_scope>",
		`This thread works on the \`${repository.name}\` repository, checked out in the worktree you are running in. Nothing outside it is in scope.`,
	];

	const linearScope: string[] = [];
	if (repository.teamKeys?.length) {
		linearScope.push(
			`team${repository.teamKeys.length > 1 ? "s" : ""} ${repository.teamKeys.join(", ")}`,
		);
	}
	if (repository.projectKeys?.length) {
		linearScope.push(
			`project${repository.projectKeys.length > 1 ? "s" : ""} ${repository.projectKeys.map((key) => `"${key}"`).join(", ")}`,
		);
	}

	if (linearScope.length > 0) {
		lines.push(
			"",
			`Linear scope for this repository: ${linearScope.join("; ")}. Constrain every Linear lookup to it — do not search the workspace at large.`,
			"An issue outside that scope belongs to a different repository. Do not read it, plan it, or act on it here: say which scope it falls in and stop.",
		);
	} else {
		lines.push(
			"",
			"This repository declares no Linear team or project, so no Linear issue is in scope for it. Work from what the thread tells you.",
		);
	}

	lines.push("</session_scope>");
	return lines.join("\n");
}

/**
 * Narrow a persisted phase, reverting anything that is not `execute` back to
 * `triage`.
 *
 * Total over the string on purpose, so it is already correct for phases that do
 * not exist yet: `runTurn` re-offers the gate only from `triage`, so a thread
 * hydrated into a phase this build cannot advance would have no open prompt,
 * nothing to re-offer one, and no path back — a permanently dead thread. The
 * worst this costs is repeating a round trip the human has already been through,
 * and it holds for a phase written by a newer build too.
 */
function hydratePhase(persisted: string): BuzzSessionPhase {
	return persisted === "execute" ? "execute" : "triage";
}

function firstLine(text: string): string {
	const line = text.split("\n", 1)[0]?.trim() ?? "";
	return line.length > 80 ? `${line.slice(0, 77)}...` : line || "Buzz thread";
}

function slugify(text: string): string {
	return (
		text
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 30) || "thread"
	);
}
