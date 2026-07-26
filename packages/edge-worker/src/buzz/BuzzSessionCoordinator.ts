import type { BuzzWebhookEvent } from "cyrus-buzz-event-transport";
import type { BuzzChannelRoute, ILogger, RepositoryConfig } from "cyrus-core";
import type { AgentSessionManager } from "../AgentSessionManager.js";
import type {
	BuzzSessionPhase,
	SessionOrchestrator,
} from "../SessionOrchestrator.js";
import type { IActivitySink } from "../sinks/IActivitySink.js";
import type { BuzzApprovalRegistry } from "./BuzzApprovalRegistry.js";
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
	getRepositoryById(repositoryId: string): RepositoryConfig | undefined;
	/** Sink bound to a channel; one per channel, created lazily by EdgeWorker. */
	getActivitySinkForChannel(channelId: string): IActivitySink;
	/**
	 * Called when a human picks 📝 rather than ▶️. Optional so the gate works
	 * without an issue tracker configured; the Linear projection supplies it.
	 */
	onTrackRequested?(request: BuzzTrackRequest): Promise<void>;
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
}

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

		const repository = this.resolveRepository(event.channelId);
		if (!repository) {
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
		const agentSessionId = await this.deps.sessionOrchestrator.startBuzzSession(
			{
				repository: context.repository,
				workspace: context.workspace,
				sessionId: context.sessionId,
				sessionKey: context.sessionKey,
				threadRootId: context.threadRootId,
				branchName: context.branchName,
				title: context.title,
				taskInstructions: prompt,
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

		const pending = this.deps.approvals.register({
			eventId,
			channelId: context.channelId,
			sessionId: context.sessionId,
			kind: "gate",
			options: [
				{
					emoji: GATE_IMPLEMENT_EMOJI,
					value: "implement",
					label: "implement",
				},
				{ emoji: GATE_TRACK_EMOJI, value: "track", label: "track" },
			],
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

	private async applyGateDecision(
		context: BuzzThreadContext,
		decision: BuzzGateDecision,
	): Promise<void> {
		if (decision === "track") {
			this.deps.logger.info(
				`Buzz thread ${context.sessionKey} tracked without implementation`,
			);
			await this.deps.onTrackRequested?.({
				sessionId: context.sessionId,
				sessionKey: context.sessionKey,
				channelId: context.channelId,
				threadRootId: context.threadRootId,
				title: context.title,
				summary: context.openingMessage,
				repository: context.repository,
			});
			return;
		}

		this.deps.logger.info(
			`Buzz thread ${context.sessionKey} approved for implementation`,
		);
		context.phase = "execute";

		// Already inside the per-session queue; enqueueing again would wait on the
		// task that is running this line.
		await this.runTurn(
			context,
			`The change above is approved. Implement it now on branch \`${context.branchName}\`, then summarise what you changed.`,
		);
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

	private resolveRepository(channelId: string): RepositoryConfig | undefined {
		const route = this.deps
			.getChannelRoutes()
			.find((candidate) => candidate.channelId === channelId);
		if (!route) return undefined;

		const repository = this.deps.getRepositoryById(route.repositoryId);
		if (!repository) {
			this.deps.logger.warn(
				`Buzz channel ${channelId} routes to unknown repository "${route.repositoryId}"`,
			);
		}
		return repository;
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
