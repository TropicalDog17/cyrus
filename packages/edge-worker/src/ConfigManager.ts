import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import { watch as chokidarWatch, type FSWatcher } from "chokidar";
import {
	type EdgeConfig,
	EdgeConfigSchema,
	type EdgeWorkerConfig,
	type ILogger,
	migrateEdgeConfig,
	normalizeConfigPaths,
	type RepositoryConfig,
} from "cyrus-core";

/**
 * Describes the set of repository-level changes detected after a config
 * file reload.  Emitted as the payload of the `configChanged` event.
 */
export interface RepositoryChanges {
	added: RepositoryConfig[];
	modified: RepositoryConfig[];
	removed: RepositoryConfig[];
	/** The fully-merged new config (caller should replace its reference). */
	newConfig: EdgeWorkerConfig;
	/**
	 * The set of top-level (non-repository) config keys whose value changed
	 * between the previous and reconciled config. Additive to the payload;
	 * lets downstream consumers dispatch selectively instead of broadcasting.
	 */
	changedKeys: Set<keyof EdgeConfig>;
}

/**
 * Events emitted by ConfigManager.
 */
export interface ConfigManagerEvents {
	configChanged: (changes: RepositoryChanges) => void;
}

/**
 * ConfigManager is responsible for watching, loading, validating, and
 * diffing the EdgeWorker configuration file.  It does **not** perform any
 * repository lifecycle operations (adding / updating / removing session
 * managers, issue trackers, etc.) -- instead it emits a `configChanged`
 * event that the EdgeWorker listens to and acts upon.
 *
 * Usage:
 * ```ts
 * const configManager = new ConfigManager(config, logger, configPath, repositories);
 * configManager.on("configChanged", async (changes) => {
 *   await removeDeletedRepositories(changes.removed);
 *   await updateModifiedRepositories(changes.modified);
 *   await addNewRepositories(changes.added);
 *   this.config = changes.newConfig;
 * });
 * configManager.startConfigWatcher();
 * ```
 */
export class ConfigManager extends EventEmitter {
	/**
	 * Legacy → canonical field renames applied during reconciliation. Each
	 * pair copies the legacy value forward to the canonical field when the
	 * canonical field is absent (nullish). The `defaultAllowedTools` →
	 * `linearAllowedTools` fold is handled separately by `migrateEdgeConfig`.
	 */
	private static readonly LEGACY_RENAMES: Array<
		[keyof EdgeConfig, keyof EdgeConfig]
	> = [
		["defaultModel", "claudeDefaultModel"],
		["defaultFallbackModel", "claudeDefaultFallbackModel"],
	];

	private config: EdgeWorkerConfig;
	private readonly logger: ILogger;
	private configPath?: string;
	/** Live reference to EdgeWorker's repository map -- used for diffing. */
	private readonly repositories: Map<string, RepositoryConfig>;
	private configWatcher?: FSWatcher;

	constructor(
		config: EdgeWorkerConfig,
		logger: ILogger,
		configPath: string | undefined,
		repositories: Map<string, RepositoryConfig>,
	) {
		super();
		this.config = config;
		this.logger = logger;
		this.configPath = configPath;
		this.repositories = repositories;
	}

	// ------------------------------------------------------------------
	// Public API
	// ------------------------------------------------------------------

	/**
	 * Start watching the config file for changes.  Each detected change
	 * triggers a reload-and-diff cycle; if repository-level changes are
	 * found a `configChanged` event is emitted.
	 */
	startConfigWatcher(): void {
		if (!this.configPath) {
			this.logger.warn("⚠️  No config path set, skipping config file watcher");
			return;
		}

		this.logger.info(`👀 Watching config file for changes: ${this.configPath}`);

		this.configWatcher = chokidarWatch(this.configPath, {
			persistent: true,
			ignoreInitial: true,
			awaitWriteFinish: {
				stabilityThreshold: 500,
				pollInterval: 100,
			},
		});

		this.configWatcher.on("change", async () => {
			this.logger.info("🔄 Config file changed, reloading...");
			await this.handleConfigChange();
		});

		this.configWatcher.on("error", (error: unknown) => {
			this.logger.error("❌ Config watcher error:", error);
		});
	}

	/**
	 * Stop the config file watcher and release resources.
	 */
	async stop(): Promise<void> {
		if (this.configWatcher) {
			await this.configWatcher.close();
			this.configWatcher = undefined;
			this.logger.info("✅ Config file watcher stopped");
		}
	}

	/**
	 * Return the current (possibly reloaded) config snapshot.
	 */
	getConfig(): EdgeWorkerConfig {
		return this.config;
	}

	/**
	 * Update the internal config reference.  This is useful when the
	 * EdgeWorker needs to push an externally-modified config back into
	 * the ConfigManager (e.g. after applying the changes from a
	 * `configChanged` event).
	 */
	setConfig(config: EdgeWorkerConfig): void {
		this.config = config;
	}

	/**
	 * Update the config file path (e.g. when set after construction).
	 */
	setConfigPath(configPath: string): void {
		this.configPath = configPath;
	}

	/**
	 * Reconcile a raw config read from disk against the previous in-memory
	 * config. This is the single owner of the merge / migration / path
	 * normalization / diff pipeline that used to be split across
	 * `loadConfigSafely` + `detectGlobalConfigChanges`.
	 *
	 * Pipeline:
	 * 1. `migrateEdgeConfig` — folds `defaultAllowedTools` → `linearAllowedTools`
	 *    and the legacy per-repo Linear token format forward (idempotent).
	 * 2. Legacy field renames (`defaultModel` → `claudeDefaultModel`, etc.)
	 *    copied forward when the canonical field is absent.
	 * 3. Validate `repositories` (falling back to `prev` when omitted) — throws
	 *    on a malformed repositories array or a repo missing required fields.
	 * 4. Uniform nullish merge over every `EdgeConfigSchema` key:
	 *    `merged[k] = disk[k] ?? prev[k]`. Runtime-only fields on `prev`
	 *    (handlers, cyrusHome, …) are preserved via the `{ ...prev }` base.
	 * 5. Path normalization via `normalizeConfigPaths` (registry-driven).
	 * 6. Generic diff → `changedKeys` (apples-to-apples: both sides are
	 *    post-normalize) + repository add/modify/remove diff.
	 *
	 * NOTE: nullish (`??`) merge is a real behavior change vs the old `||` —
	 * disk values of `false`, `0`, `""`, and `[]` are now honored instead of
	 * falling back to the previous in-memory value.
	 */
	reconcile(
		prev: EdgeWorkerConfig,
		disk: unknown,
	): {
		merged: EdgeWorkerConfig;
		changedKeys: Set<keyof EdgeConfig>;
		repositoryChanges: {
			added: RepositoryConfig[];
			modified: RepositoryConfig[];
			removed: RepositoryConfig[];
		};
	} {
		// (1) migrate legacy shapes forward (idempotent).
		const migrated = migrateEdgeConfig((disk ?? {}) as Record<string, unknown>);

		// (2) apply legacy field renames when the canonical value is absent.
		for (const [legacy, canonical] of ConfigManager.LEGACY_RENAMES) {
			if (migrated[canonical] == null && migrated[legacy] != null) {
				migrated[canonical] = migrated[legacy];
			}
		}

		// (3) validate repositories (fall back to prev when omitted entirely).
		const diskRepos = migrated.repositories;
		if (diskRepos !== undefined && !Array.isArray(diskRepos)) {
			throw new Error("Invalid config: repositories must be an array");
		}
		const effectiveRepos = (
			Array.isArray(diskRepos) ? diskRepos : prev.repositories
		) as RepositoryConfig[];
		for (const repo of effectiveRepos) {
			if (!repo.id || !repo.name || !repo.repositoryPath || !repo.baseBranch) {
				throw new Error(
					"Invalid repository config: missing required fields (id, name, repositoryPath, baseBranch)",
				);
			}
		}

		// (4) uniform nullish merge, preserving runtime-only fields from prev.
		const merged: EdgeWorkerConfig = { ...prev };
		const mergedRecord = merged as unknown as Record<string, unknown>;
		const prevRecord = prev as unknown as Record<string, unknown>;
		const migratedRecord = migrated as Record<string, unknown>;
		for (const key of Object.keys(EdgeConfigSchema.shape)) {
			const diskValue = migratedRecord[key];
			mergedRecord[key] = diskValue ?? prevRecord[key];
		}

		// (5) path normalization (registry-driven, top-level + per-repo).
		const normalized = normalizeConfigPaths(merged);

		// (6a) generic diff → changedKeys (both sides post-normalize).
		const changedKeys = new Set<keyof EdgeConfig>();
		const normalizedRecord = normalized as unknown as Record<string, unknown>;
		for (const key of Object.keys(EdgeConfigSchema.shape)) {
			if (key === "repositories") continue;
			if (!this.deepEqual(prevRecord[key], normalizedRecord[key])) {
				changedKeys.add(key as keyof EdgeConfig);
			}
		}

		// (6b) repository add/modify/remove diff against the live map.
		const repositoryChanges = this.detectRepositoryChanges(normalized);

		return { merged: normalized, changedKeys, repositoryChanges };
	}

	// ------------------------------------------------------------------
	// Internal helpers
	// ------------------------------------------------------------------

	/**
	 * Handle a config file change event: read, reconcile, and emit.
	 */
	private async handleConfigChange(): Promise<void> {
		try {
			if (!this.configPath) {
				this.logger.error("❌ No config path set");
				return;
			}

			let raw: unknown;
			try {
				const configContent = await readFile(this.configPath, "utf-8");
				raw = JSON.parse(configContent);
			} catch (error) {
				this.logger.error("❌ Failed to load config file:", error);
				return;
			}

			let result: ReturnType<ConfigManager["reconcile"]>;
			try {
				result = this.reconcile(this.config, raw);
			} catch (error) {
				this.logger.error("❌ Failed to reload configuration:", error);
				return;
			}

			const { changedKeys, repositoryChanges } = result;
			const hasRepoChanges =
				repositoryChanges.added.length > 0 ||
				repositoryChanges.modified.length > 0 ||
				repositoryChanges.removed.length > 0;

			if (changedKeys.size === 0 && !hasRepoChanges) {
				this.logger.info("ℹ️  No config changes detected");
				return;
			}

			if (hasRepoChanges) {
				this.logger.info(
					`📊 Repository changes detected: ${repositoryChanges.added.length} added, ${repositoryChanges.modified.length} modified, ${repositoryChanges.removed.length} removed`,
				);
			}
			if (changedKeys.size > 0) {
				this.logger.info(
					`📊 Global config changes detected: ${[...changedKeys].join(", ")}`,
				);
			}

			// Emit the diff so EdgeWorker can orchestrate the mutations.
			this.emit("configChanged", {
				added: repositoryChanges.added,
				modified: repositoryChanges.modified,
				removed: repositoryChanges.removed,
				newConfig: result.merged,
				changedKeys,
			} satisfies RepositoryChanges);
		} catch (error) {
			this.logger.error("❌ Failed to reload configuration:", error);
		}
	}

	/**
	 * Detect changes between the current in-memory repository map and
	 * the repositories declared in `newConfig`.
	 */
	private detectRepositoryChanges(newConfig: EdgeWorkerConfig): {
		added: RepositoryConfig[];
		modified: RepositoryConfig[];
		removed: RepositoryConfig[];
	} {
		const currentRepos = new Map(this.repositories);
		const newRepos = new Map<string, RepositoryConfig>(
			newConfig.repositories.map((r: RepositoryConfig) => [r.id, r]),
		);

		const added: RepositoryConfig[] = [];
		const modified: RepositoryConfig[] = [];
		const removed: RepositoryConfig[] = [];

		// Find added and modified repositories
		for (const [id, repo] of newRepos) {
			if (!currentRepos.has(id)) {
				added.push(repo);
			} else {
				const currentRepo = currentRepos.get(id);
				if (currentRepo && !this.deepEqual(currentRepo, repo)) {
					modified.push(repo);
				}
			}
		}

		// Find removed repositories
		for (const [id, repo] of currentRepos) {
			if (!newRepos.has(id)) {
				removed.push(repo);
			}
		}

		return { added, modified, removed };
	}

	/**
	 * Deep equality check for repository configs.
	 */
	private deepEqual(obj1: unknown, obj2: unknown): boolean {
		return JSON.stringify(obj1) === JSON.stringify(obj2);
	}
}
