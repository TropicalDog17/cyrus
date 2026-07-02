import { existsSync, readFileSync } from "node:fs";
import { mkdir, open, rename, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
	CyrusAgentSession,
	CyrusAgentSessionEntry,
	IssueContext,
	IssueMinimal,
} from "./CyrusAgentSession.js";
import { createLogger, type ILogger } from "./logging/index.js";

/** Current persistence format version */
export const PERSISTENCE_VERSION = "4.0";

// Serialized versions with Date fields as strings
export type SerializedCyrusAgentSession = CyrusAgentSession;
// extends Omit<CyrusAgentSession, 'createdAt' | 'updatedAt'> {
//   createdAt: string
//   updatedAt: string
// }

export type SerializedCyrusAgentSessionEntry = CyrusAgentSessionEntry;
// extends Omit<CyrusAgentSessionEntry, 'metadata'> {
//   metadata?: Omit<CyrusAgentSessionEntry['metadata'], 'timestamp'> & {
//     timestamp?: string
//   }
// }

/**
 * v2.0 session format (for migration purposes)
 */
interface V2CyrusAgentSession {
	linearAgentActivitySessionId: string;
	type: string;
	status: string;
	context: string;
	createdAt: number;
	updatedAt: number;
	issueId: string;
	issue: IssueMinimal;
	workspace: {
		path: string;
		isGitWorktree: boolean;
		historyPath?: string;
	};
	claudeSessionId?: string;
	geminiSessionId?: string;
	metadata?: Record<string, unknown>;
}

/**
 * Serializable EdgeWorker state for persistence
 *
 * v4.0: Flat session format - sessions keyed directly by sessionId (no repo nesting)
 * v3.0: Nested format - sessions keyed by [repoId][sessionId]
 */
export interface SerializableEdgeWorkerState {
	// Agent Session state - flat map of sessionId → session (v4.0)
	agentSessions?: Record<string, SerializedCyrusAgentSession>;
	agentSessionEntries?: Record<string, SerializedCyrusAgentSessionEntry[]>;
	// Child to parent agent session mapping
	childToParentAgentSession?: Record<string, string>;
	// Issue to repository mapping (for caching user repository selections)
	// v4.1: string[] (multi-repo). Migration: old Record<string, string> auto-converts.
	issueRepositoryCache?: Record<string, string[]>;
}

/**
 * v3.0 nested state format (for migration purposes)
 */
export interface V3SerializableEdgeWorkerState {
	agentSessions?: Record<string, Record<string, SerializedCyrusAgentSession>>;
	agentSessionEntries?: Record<
		string,
		Record<string, SerializedCyrusAgentSessionEntry[]>
	>;
	childToParentAgentSession?: Record<string, string>;
	issueRepositoryCache?: Record<string, string>;
}

/**
 * Manages persistence of critical mappings to survive restarts
 */
export class PersistenceManager {
	private persistencePath: string;
	private logger: ILogger;

	// Single-flight write coordination. Concurrent callers coalesce onto the
	// latest state so overlapping fire-and-forget saves can never interleave
	// writes to the same file (which previously risked a corrupt/partial file).
	private pendingState: SerializableEdgeWorkerState | undefined;
	private writeChain: Promise<void> = Promise.resolve();
	private writing = false;

	constructor(persistencePath?: string, logger?: ILogger) {
		this.persistencePath =
			persistencePath || join(homedir(), ".cyrus", "state");
		this.logger = logger ?? createLogger({ component: "PersistenceManager" });
	}

	/**
	 * Get the full path to the single EdgeWorker state file
	 */
	private getEdgeWorkerStateFilePath(): string {
		return join(this.persistencePath, "edge-worker-state.json");
	}

	/**
	 * Ensure the persistence directory exists
	 */
	private async ensurePersistenceDirectory(): Promise<void> {
		await mkdir(this.persistencePath, { recursive: true });
	}

	/**
	 * Save EdgeWorker state to disk (single file for all repositories).
	 *
	 * Writes are serialized through a single-flight queue and coalesced to the
	 * most recently requested state, so overlapping callers (including the many
	 * fire-and-forget savePersistedState() call sites) can never interleave and
	 * corrupt the file. Each write is atomic: the payload is written to a temp
	 * file, fsync'd, the previous good file is rotated to `.bak`, then the temp
	 * file is atomically renamed into place. A crash therefore leaves either the
	 * previous complete file or the new complete file — never a truncated one.
	 */
	async saveEdgeWorkerState(state: SerializableEdgeWorkerState): Promise<void> {
		this.pendingState = state;
		if (!this.writing) {
			this.writing = true;
			this.writeChain = this.drainWrites();
		}
		return this.writeChain;
	}

	/**
	 * Drain all pending state writes, one at a time, coalescing to the latest.
	 */
	private async drainWrites(): Promise<void> {
		try {
			while (this.pendingState !== undefined) {
				const state = this.pendingState;
				this.pendingState = undefined;
				await this.writeStateAtomic(state);
			}
		} catch (error) {
			this.logger.error("Failed to save EdgeWorker state:", error);
			throw error;
		} finally {
			this.writing = false;
		}
	}

	/**
	 * Atomically write a single state snapshot to disk (temp + fsync + rename),
	 * rotating the previous good file to `.bak` for crash recovery.
	 */
	private async writeStateAtomic(
		state: SerializableEdgeWorkerState,
	): Promise<void> {
		await this.ensurePersistenceDirectory();
		const stateFile = this.getEdgeWorkerStateFilePath();
		const tmpFile = `${stateFile}.tmp`;
		const bakFile = `${stateFile}.bak`;
		const payload = JSON.stringify(
			{
				version: PERSISTENCE_VERSION,
				savedAt: new Date().toISOString(),
				state,
			},
			null,
			2,
		);

		// Write + fsync to a temp file so the bytes are durable before we swap.
		const handle = await open(tmpFile, "w");
		try {
			await handle.writeFile(payload, "utf8");
			await handle.sync();
		} finally {
			await handle.close();
		}

		// Rotate the current good file to `.bak` (atomic), then swap in the new
		// one (atomic). If a crash lands between these two renames, loadState()
		// falls back to `.bak`, so no complete snapshot is ever lost.
		if (existsSync(stateFile)) {
			try {
				await rename(stateFile, bakFile);
			} catch (error) {
				this.logger.warn("Failed to rotate state backup:", error);
			}
		}
		await rename(tmpFile, stateFile);
	}

	/**
	 * Load EdgeWorker state from disk (single file for all repositories)
	 * Automatically migrates from v2.0 to v3.0 format if needed.
	 */
	async loadEdgeWorkerState(): Promise<SerializableEdgeWorkerState | null> {
		try {
			const stateFile = this.getEdgeWorkerStateFilePath();
			const bakFile = `${stateFile}.bak`;

			// Try the primary file first; on missing/corrupt fall back to `.bak`.
			// This covers both a truncated primary and the narrow window between
			// the two renames in writeStateAtomic() where only `.bak` exists.
			let stateData = this.tryReadStateFile(stateFile);
			if (stateData === undefined) {
				const recovered = this.tryReadStateFile(bakFile);
				if (recovered !== undefined) {
					this.logger.warn(
						"Primary state file unreadable; recovered from .bak backup",
					);
					stateData = recovered;
				}
			}

			// undefined => primary absent AND no usable backup. If the primary
			// file is genuinely absent this is a fresh install (quiet null); if
			// it existed but was corrupt, tryReadStateFile already logged an error.
			if (stateData === undefined) {
				return null;
			}

			// Validate state structure exists
			if (!stateData.state) {
				this.logger.warn("Invalid state file (missing state), ignoring");
				return null;
			}

			// Handle version migration
			if (stateData.version === "2.0") {
				this.logger.info("Migrating state from v2.0 to v3.0 to v4.0");
				const v3State = this.migrateV2ToV3(stateData.state);
				const migratedState = this.migrateV3ToV4(v3State);
				await this.saveEdgeWorkerState(migratedState);
				this.logger.info(
					`Migration complete, saved as v${PERSISTENCE_VERSION}`,
				);
				return migratedState;
			}

			if (stateData.version === "3.0") {
				this.logger.info("Migrating state from v3.0 to v4.0");
				const migratedState = this.migrateV3ToV4(
					stateData.state as V3SerializableEdgeWorkerState,
				);
				await this.saveEdgeWorkerState(migratedState);
				this.logger.info(
					`Migration complete, saved as v${PERSISTENCE_VERSION}`,
				);
				return migratedState;
			}

			if (stateData.version !== PERSISTENCE_VERSION) {
				this.logger.warn(
					`Unknown state file version ${stateData.version}, ignoring`,
				);
				return null;
			}

			return stateData.state;
		} catch (error) {
			this.logger.error("Failed to load EdgeWorker state:", error);
			return null;
		}
	}

	/**
	 * Migrate v2.0 state format to v3.0 format
	 *
	 * Changes:
	 * - linearAgentActivitySessionId -> id
	 * - Add externalSessionId (set to original linearAgentActivitySessionId for Linear sessions)
	 * - Add issueContext object with trackerId, issueId, issueIdentifier
	 * - issueId becomes optional (kept for backwards compatibility)
	 * - issue becomes optional
	 */
	private migrateV2ToV3(
		v2State: V3SerializableEdgeWorkerState,
	): V3SerializableEdgeWorkerState {
		const migratedState: V3SerializableEdgeWorkerState = {
			...v2State,
			agentSessions: {},
		};

		// Migrate agent sessions
		if (v2State.agentSessions) {
			for (const [repoId, repoSessions] of Object.entries(
				v2State.agentSessions,
			)) {
				migratedState.agentSessions![repoId] = {};
				for (const [_sessionId, v2Session] of Object.entries(repoSessions)) {
					const session = v2Session as unknown as V2CyrusAgentSession;
					const migratedSession = this.migrateSessionV2ToV3(session);
					// Use the new id as the key
					migratedState.agentSessions![repoId][migratedSession.id] =
						migratedSession;
				}
			}
		}

		// agentSessionEntries keys need to be updated to use new session IDs
		// Since linearAgentActivitySessionId becomes id, the keys remain the same
		// The entries themselves don't need modification

		return migratedState;
	}

	/**
	 * Migrate v3.0 state format to v4.0 format
	 *
	 * Changes:
	 * - Flatten nested {[repoId]: {[sessionId]: session}} to flat {[sessionId]: session}
	 * - Flatten nested entries similarly
	 */
	private migrateV3ToV4(
		v3State: V3SerializableEdgeWorkerState,
	): SerializableEdgeWorkerState {
		const flatSessions: Record<string, SerializedCyrusAgentSession> = {};
		const flatEntries: Record<string, SerializedCyrusAgentSessionEntry[]> = {};

		// Flatten sessions: merge all repo-keyed sessions into a single flat map
		// Preserve the repoId key as a RepositoryContext so migrated sessions
		// know which repository they belong to (instead of defaulting to [])
		if (v3State.agentSessions) {
			for (const [repoId, repoSessions] of Object.entries(
				v3State.agentSessions,
			)) {
				for (const [sessionId, session] of Object.entries(repoSessions)) {
					if (!session.repositories?.length) {
						session.repositories = [
							{
								repositoryId: repoId,
							},
						];
					}
					flatSessions[sessionId] = session;
				}
			}
		}

		// Flatten entries similarly
		if (v3State.agentSessionEntries) {
			for (const repoEntries of Object.values(v3State.agentSessionEntries)) {
				for (const [sessionId, entries] of Object.entries(repoEntries)) {
					flatEntries[sessionId] = entries;
				}
			}
		}

		// Migrate issueRepositoryCache from old Record<string, string> to Record<string, string[]>
		let migratedCache: Record<string, string[]> | undefined;
		if (v3State.issueRepositoryCache) {
			migratedCache = {};
			for (const [issueId, repoId] of Object.entries(
				v3State.issueRepositoryCache,
			)) {
				migratedCache[issueId] = [repoId];
			}
		}

		return {
			agentSessions: flatSessions,
			agentSessionEntries: flatEntries,
			childToParentAgentSession: v3State.childToParentAgentSession,
			issueRepositoryCache: migratedCache,
		};
	}

	/**
	 * Migrate a single session from v2.0 to v3.0 format
	 */
	private migrateSessionV2ToV3(
		v2Session: V2CyrusAgentSession,
	): SerializedCyrusAgentSession {
		// Build issueContext from v2.0 fields
		const issueContext: IssueContext = {
			trackerId: "linear", // v2.0 only supported Linear
			issueId: v2Session.issueId,
			issueIdentifier: v2Session.issue?.identifier || v2Session.issueId,
		};

		return {
			// New field: rename linearAgentActivitySessionId to id
			id: v2Session.linearAgentActivitySessionId,
			// New field: store the original Linear session ID as externalSessionId
			externalSessionId: v2Session.linearAgentActivitySessionId,
			// Preserved fields
			type: v2Session.type,
			status: v2Session.status,
			context: v2Session.context,
			createdAt: v2Session.createdAt,
			updatedAt: v2Session.updatedAt,
			workspace: v2Session.workspace,
			claudeSessionId: v2Session.claudeSessionId,
			geminiSessionId: v2Session.geminiSessionId,
			metadata: v2Session.metadata,
			// New field: structured issue context
			issueContext,
			// Kept for backwards compatibility (marked as deprecated in interface)
			issueId: v2Session.issueId,
			// Now optional
			issue: v2Session.issue,
			// New field: empty repositories for migrated sessions
			repositories: [],
		} as SerializedCyrusAgentSession;
	}

	/**
	 * Read and JSON-parse a state file.
	 *
	 * Returns the parsed object, or `undefined` if the file is absent, empty, or
	 * corrupt. A present-but-unparseable file is logged at error level (so a real
	 * corruption event is visible), while an absent or empty file is treated as
	 * "no state" without noise — distinguishing corruption from a fresh/cleared
	 * install, which the previous implementation could not do.
	 */
	private tryReadStateFile(
		path: string,
	): { version?: string; state?: any } | undefined {
		if (!existsSync(path)) {
			return undefined;
		}
		let raw: string;
		try {
			raw = readFileSync(path, "utf8");
		} catch (error) {
			this.logger.error(`Failed to read state file ${path}:`, error);
			return undefined;
		}
		if (raw.trim() === "") {
			return undefined; // intentionally cleared / empty file
		}
		try {
			return JSON.parse(raw);
		} catch (error) {
			this.logger.error(`State file ${path} is corrupt (invalid JSON):`, error);
			return undefined;
		}
	}

	/**
	 * Check if EdgeWorker state file exists
	 */
	hasStateFile(): boolean {
		return existsSync(this.getEdgeWorkerStateFilePath());
	}

	/**
	 * Delete EdgeWorker state file (and its temp/backup siblings).
	 *
	 * The siblings must go too: otherwise loadEdgeWorkerState() would recover the
	 * just-deleted state from `.bak`, resurrecting sessions the caller meant to
	 * clear.
	 */
	async deleteStateFile(): Promise<void> {
		const stateFile = this.getEdgeWorkerStateFilePath();
		for (const file of [stateFile, `${stateFile}.tmp`, `${stateFile}.bak`]) {
			try {
				if (existsSync(file)) {
					await unlink(file);
				}
			} catch (error) {
				this.logger.error(`Failed to delete state file ${file}:`, error);
			}
		}
	}

	/**
	 * Convert Map to Record for serialization
	 */
	static mapToRecord<T>(map: Map<string, T>): Record<string, T> {
		return Object.fromEntries(map.entries());
	}

	/**
	 * Convert Record to Map for deserialization
	 */
	static recordToMap<T>(record: Record<string, T>): Map<string, T> {
		return new Map(Object.entries(record));
	}

	/**
	 * Convert Set to Array for serialization
	 */
	static setToArray<T>(set: Set<T>): T[] {
		return Array.from(set);
	}

	/**
	 * Convert Array to Set for deserialization
	 */
	static arrayToSet<T>(array: T[]): Set<T> {
		return new Set(array);
	}
}
