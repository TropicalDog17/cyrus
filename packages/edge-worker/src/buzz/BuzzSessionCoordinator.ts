import type { BuzzWebhookEvent } from "cyrus-buzz-event-transport";
import type { BuzzChannelRoute, ILogger, RepositoryConfig } from "cyrus-core";
import type { AgentSessionManager } from "../AgentSessionManager.js";
import type { SessionOrchestrator } from "../SessionOrchestrator.js";
import type { IActivitySink } from "../sinks/IActivitySink.js";
import type { BuzzCliClient, BuzzEventRecord } from "./BuzzCliClient.js";

export interface BuzzSessionCoordinatorDeps {
	logger: ILogger;
	client: BuzzCliClient;
	agentSessionManager: AgentSessionManager;
	sessionOrchestrator: SessionOrchestrator;
	/** Channel-to-repository routes from `config.buzz.channels`. */
	getChannelRoutes(): BuzzChannelRoute[];
	getRepositoryById(repositoryId: string): RepositoryConfig | undefined;
	/** Sink bound to a channel; one per channel, created lazily by EdgeWorker. */
	getActivitySinkForChannel(channelId: string): IActivitySink;
}

/**
 * Number of hex characters of the thread root that name a Buzz session. Six
 * gives ~16.7M values, which is far beyond the number of live conversations a
 * deployment has, while staying short enough to read in a branch name.
 */
const SESSION_KEY_LENGTH = 6;

/** How many delivery ids to remember for duplicate suppression. */
const MAX_SEEN_DELIVERIES = 500;

/**
 * Turns a Buzz trigger into a Cyrus session.
 *
 * Session identity is synthesized, not refactored: a Buzz thread mints a
 * `BUZZ-a1b2c3` identifier from its root event id, exactly as a GitHub PR
 * mints `PR-123`. Nothing downstream — worktree naming, branch naming, session
 * state — needs to know that no issue tracker is involved.
 *
 * The thread root, not the triggering message, is the durable identity: every
 * follow-up message in the same thread resumes the same session.
 */
export class BuzzSessionCoordinator {
	private readonly deps: BuzzSessionCoordinatorDeps;
	private readonly seenDeliveries = new Set<string>();

	constructor(deps: BuzzSessionCoordinatorDeps) {
		this.deps = deps;
	}

	async handleEvent(event: BuzzWebhookEvent): Promise<void> {
		const { logger } = this.deps;

		if (this.isDuplicate(event.deliveryId)) {
			logger.debug(`Ignoring duplicate Buzz delivery ${event.deliveryId}`);
			return;
		}

		if (event.eventType === "reaction_added") {
			// Reactions carry the execution gate (📝 track / ▶️ implement), which
			// lands with the approval protocol. Accepting them here without that
			// protocol would let a thumbs-up start a coding session.
			logger.debug(
				`Ignoring Buzz reaction ${event.emoji ?? ""} — the reaction protocol is not wired yet`,
			);
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
		const existing = this.deps.agentSessionManager.getSession(sessionId);

		if (existing) {
			await this.resume(sessionId, prompt, repository, event);
			return;
		}

		await this.start(sessionId, threadRootId, prompt, repository, event);
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

	private async start(
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

		await this.deps.sessionOrchestrator.startBuzzSession({
			repository,
			workspace,
			sessionId,
			sessionKey,
			threadRootId,
			branchName,
			title,
			taskInstructions: prompt,
			activitySink: this.deps.getActivitySinkForChannel(event.channelId),
		});
	}

	private async resume(
		sessionId: string,
		prompt: string,
		repository: RepositoryConfig,
		event: BuzzWebhookEvent,
	): Promise<void> {
		const session = this.deps.agentSessionManager.getSession(sessionId);
		if (!session) return;

		this.deps.logger.info(
			`Resuming Buzz session ${sessionId} with a follow-up message`,
		);

		try {
			await this.deps.sessionOrchestrator.resumeSession(
				session,
				repository,
				sessionId,
				this.deps.agentSessionManager,
				prompt,
				"", // attachmentManifest
				false, // isNewSession
				[], // additionalAllowedDirectories
				undefined, // linearWorkspaceId
				undefined, // maxTurns
				event.authorPubkey,
				event.timestamp,
			);
		} catch (error) {
			this.deps.logger.error(
				`Failed to resume Buzz session ${sessionId}`,
				error instanceof Error ? error : new Error(String(error)),
			);
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
	 * buzz-workflow retries a `call_webhook` step that does not return 2xx
	 * promptly, so the same message can arrive twice. Without this, the second
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
