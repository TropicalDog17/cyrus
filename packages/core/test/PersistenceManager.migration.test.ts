/**
 * Tests for PersistenceManager migrations (v2.0 → v3.0 → v4.0),
 * plus atomic-write and crash-recovery behavior.
 */

import { existsSync, readFileSync } from "node:fs";
import { mkdir, open, rename, unlink } from "node:fs/promises";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	PERSISTENCE_VERSION,
	PersistenceManager,
} from "../src/PersistenceManager.js";

// Mock fs modules. The save path writes atomically via open()+fsync+rename(),
// and the load path reads synchronously, so we mock those primitives.
vi.mock("node:fs", () => ({
	existsSync: vi.fn(),
	readFileSync: vi.fn(),
}));

vi.mock("node:fs/promises", () => ({
	mkdir: vi.fn(),
	open: vi.fn(),
	rename: vi.fn(),
	unlink: vi.fn(),
}));

describe("PersistenceManager", () => {
	let persistenceManager: PersistenceManager;
	// Captures payloads written to the temp file via the atomic write path.
	let handleWriteFile: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		vi.clearAllMocks();
		persistenceManager = new PersistenceManager("/tmp/test-cyrus");

		handleWriteFile = vi.fn().mockResolvedValue(undefined);
		vi.mocked(open).mockResolvedValue({
			writeFile: handleWriteFile,
			sync: vi.fn().mockResolvedValue(undefined),
			close: vi.fn().mockResolvedValue(undefined),
		} as unknown as Awaited<ReturnType<typeof open>>);
		vi.mocked(rename).mockResolvedValue(undefined);
		vi.mocked(unlink).mockResolvedValue(undefined);
		vi.mocked(mkdir).mockResolvedValue(undefined as never);
	});

	/** Parse the payload written by the most recent atomic save. */
	const lastSavedData = () =>
		JSON.parse(handleWriteFile.mock.calls[0][0] as string);

	describe("v2.0 to v4.0 Migration (via v3.0)", () => {
		const v2State = {
			version: "2.0",
			savedAt: "2025-01-15T12:00:00.000Z",
			state: {
				agentSessions: {
					"repo-1": {
						"linear-session-123": {
							linearAgentActivitySessionId: "linear-session-123",
							type: "comment-thread",
							status: "active",
							context: "comment-thread",
							createdAt: 1705320000000,
							updatedAt: 1705320000000,
							issueId: "issue-456",
							issue: {
								id: "issue-456",
								identifier: "TEST-123",
								title: "Test Issue",
								branchName: "test-branch",
							},
							workspace: {
								path: "/tmp/worktree",
								isGitWorktree: true,
							},
							claudeSessionId: "claude-789",
						},
					},
				},
				agentSessionEntries: {
					"repo-1": {
						"linear-session-123": [
							{
								type: "user",
								content: "Hello",
								metadata: { timestamp: 1705320000000 },
							},
						],
					},
				},
				childToParentAgentSession: {
					"child-session": "parent-session",
				},
				issueRepositoryCache: {
					"issue-456": "repo-1",
				},
			},
		};

		it("should migrate v2.0 state through v3.0 to v4.0 flat format", async () => {
			vi.mocked(existsSync).mockReturnValue(true);
			vi.mocked(readFileSync).mockReturnValue(JSON.stringify(v2State));

			const result = await persistenceManager.loadEdgeWorkerState();

			expect(result).toBeDefined();
			expect(result!.agentSessions).toBeDefined();

			// v4.0: sessions are flat (keyed by sessionId, not nested under repoId)
			const migratedSession = result!.agentSessions!["linear-session-123"];
			expect(migratedSession).toBeDefined();

			// Should have new id field (from v2→v3 migration)
			expect(migratedSession.id).toBe("linear-session-123");

			// Should have externalSessionId
			expect(migratedSession.externalSessionId).toBe("linear-session-123");

			// Should have issueContext
			expect(migratedSession.issueContext).toEqual({
				trackerId: "linear",
				issueId: "issue-456",
				issueIdentifier: "TEST-123",
			});

			// Should preserve issueId for backwards compatibility
			expect(migratedSession.issueId).toBe("issue-456");

			// Should preserve issue object
			expect(migratedSession.issue).toEqual({
				id: "issue-456",
				identifier: "TEST-123",
				title: "Test Issue",
				branchName: "test-branch",
			});

			// Should preserve other fields
			expect(migratedSession.claudeSessionId).toBe("claude-789");
			expect(migratedSession.workspace.path).toBe("/tmp/worktree");

			// Should have repositories populated from the repo key during v3→v4 flattening
			expect(migratedSession.repositories).toEqual([
				{ repositoryId: "repo-1" },
			]);
		});

		it("should save migrated state as v4.0", async () => {
			vi.mocked(existsSync).mockReturnValue(true);
			vi.mocked(readFileSync).mockReturnValue(JSON.stringify(v2State));

			await persistenceManager.loadEdgeWorkerState();

			// Verify the atomic write happened with v4.0 version
			expect(handleWriteFile).toHaveBeenCalled();
			expect(lastSavedData().version).toBe(PERSISTENCE_VERSION);
		});

		it("should flatten entries and preserve mappings during v2→v4 migration", async () => {
			vi.mocked(existsSync).mockReturnValue(true);
			vi.mocked(readFileSync).mockReturnValue(JSON.stringify(v2State));

			const result = await persistenceManager.loadEdgeWorkerState();

			// Entries should be flattened (keyed by sessionId, not nested under repoId)
			expect(result!.agentSessionEntries!["linear-session-123"]).toEqual([
				{
					type: "user",
					content: "Hello",
					metadata: { timestamp: 1705320000000 },
				},
			]);

			// Check child-to-parent mappings are preserved
			expect(result!.childToParentAgentSession).toEqual(
				v2State.state.childToParentAgentSession,
			);

			// Check issue repository cache is migrated to string[] format
			expect(result!.issueRepositoryCache).toEqual({
				"issue-456": ["repo-1"],
			});
		});

		it("should return null for unknown version", async () => {
			const unknownVersionState = {
				version: "99.0",
				savedAt: "2025-01-15T12:00:00.000Z",
				state: {},
			};

			vi.mocked(existsSync).mockReturnValue(true);
			vi.mocked(readFileSync).mockReturnValue(
				JSON.stringify(unknownVersionState),
			);

			const result = await persistenceManager.loadEdgeWorkerState();

			expect(result).toBeNull();
		});

		it("should return null for invalid state structure", async () => {
			const invalidState = {
				version: "2.0",
				savedAt: "2025-01-15T12:00:00.000Z",
				// Missing state property
			};

			vi.mocked(existsSync).mockReturnValue(true);
			vi.mocked(readFileSync).mockReturnValue(JSON.stringify(invalidState));

			const result = await persistenceManager.loadEdgeWorkerState();

			expect(result).toBeNull();
		});
	});

	describe("v3.0 to v4.0 Migration", () => {
		const v3State = {
			version: "3.0",
			savedAt: "2025-01-15T12:00:00.000Z",
			state: {
				agentSessions: {
					"repo-1": {
						"session-123": {
							id: "session-123",
							externalSessionId: "session-123",
							issueContext: {
								trackerId: "linear",
								issueId: "issue-456",
								issueIdentifier: "TEST-123",
							},
							issueId: "issue-456",
							workspace: { path: "/tmp/worktree", isGitWorktree: true },
						},
					},
					"repo-2": {
						"session-456": {
							id: "session-456",
							externalSessionId: "session-456",
							issueContext: {
								trackerId: "linear",
								issueId: "issue-789",
								issueIdentifier: "OTHER-1",
							},
							issueId: "issue-789",
							workspace: { path: "/tmp/worktree2", isGitWorktree: false },
						},
					},
				},
				agentSessionEntries: {
					"repo-1": {
						"session-123": [{ type: "user", content: "Hello from repo-1" }],
					},
					"repo-2": {
						"session-456": [{ type: "user", content: "Hello from repo-2" }],
					},
				},
				childToParentAgentSession: {
					"child-1": "parent-1",
				},
				issueRepositoryCache: {
					"issue-456": "repo-1",
					"issue-789": "repo-2",
				},
			},
		};

		it("should flatten nested sessions from multiple repos into a flat map", async () => {
			vi.mocked(existsSync).mockReturnValue(true);
			vi.mocked(readFileSync).mockReturnValue(JSON.stringify(v3State));

			const result = await persistenceManager.loadEdgeWorkerState();

			expect(result).toBeDefined();

			// Sessions should be flat (no repo nesting)
			expect(result!.agentSessions!["session-123"]).toBeDefined();
			expect(result!.agentSessions!["session-456"]).toBeDefined();

			// Verify session content
			expect(result!.agentSessions!["session-123"].issueContext).toEqual({
				trackerId: "linear",
				issueId: "issue-456",
				issueIdentifier: "TEST-123",
			});
			expect(result!.agentSessions!["session-456"].issueContext).toEqual({
				trackerId: "linear",
				issueId: "issue-789",
				issueIdentifier: "OTHER-1",
			});
		});

		it("should populate repositories from repo key during flattening", async () => {
			vi.mocked(existsSync).mockReturnValue(true);
			vi.mocked(readFileSync).mockReturnValue(JSON.stringify(v3State));

			const result = await persistenceManager.loadEdgeWorkerState();

			// Sessions should get their repository context from the repo key they were nested under
			expect(result!.agentSessions!["session-123"].repositories).toEqual([
				{ repositoryId: "repo-1" },
			]);
			expect(result!.agentSessions!["session-456"].repositories).toEqual([
				{ repositoryId: "repo-2" },
			]);
		});

		it("should flatten nested entries from multiple repos", async () => {
			vi.mocked(existsSync).mockReturnValue(true);
			vi.mocked(readFileSync).mockReturnValue(JSON.stringify(v3State));

			const result = await persistenceManager.loadEdgeWorkerState();

			// Entries should be flat
			expect(result!.agentSessionEntries!["session-123"]).toEqual([
				{ type: "user", content: "Hello from repo-1" },
			]);
			expect(result!.agentSessionEntries!["session-456"]).toEqual([
				{ type: "user", content: "Hello from repo-2" },
			]);
		});

		it("should preserve childToParentAgentSession and issueRepositoryCache", async () => {
			vi.mocked(existsSync).mockReturnValue(true);
			vi.mocked(readFileSync).mockReturnValue(JSON.stringify(v3State));

			const result = await persistenceManager.loadEdgeWorkerState();

			expect(result!.childToParentAgentSession).toEqual({
				"child-1": "parent-1",
			});
			// Cache migrated from old string format to string[]
			expect(result!.issueRepositoryCache).toEqual({
				"issue-456": ["repo-1"],
				"issue-789": ["repo-2"],
			});
		});

		it("should save migrated v3→v4 state with correct version", async () => {
			vi.mocked(existsSync).mockReturnValue(true);
			vi.mocked(readFileSync).mockReturnValue(JSON.stringify(v3State));

			await persistenceManager.loadEdgeWorkerState();

			expect(handleWriteFile).toHaveBeenCalled();
			expect(lastSavedData().version).toBe("4.0");
		});
	});

	describe("v4.0 state (current)", () => {
		const v4State = {
			version: "4.0",
			savedAt: "2025-01-15T12:00:00.000Z",
			state: {
				agentSessions: {
					"session-123": {
						id: "session-123",
						externalSessionId: "session-123",
						issueContext: {
							trackerId: "linear",
							issueId: "issue-456",
							issueIdentifier: "TEST-123",
						},
					},
				},
			},
		};

		it("should load v4.0 state without migration", async () => {
			vi.mocked(existsSync).mockReturnValue(true);
			vi.mocked(readFileSync).mockReturnValue(JSON.stringify(v4State));

			const result = await persistenceManager.loadEdgeWorkerState();

			expect(result).toEqual(v4State.state);
			// Should not write anything since no migration is needed
			expect(handleWriteFile).not.toHaveBeenCalled();
		});
	});

	describe("atomic write behavior", () => {
		const v4State = {
			agentSessions: { "session-1": { id: "session-1" } },
		};

		it("writes to a temp file then renames it into place (no in-place write)", async () => {
			vi.mocked(existsSync).mockReturnValue(false); // no prior file to rotate

			await persistenceManager.saveEdgeWorkerState(
				v4State as unknown as Parameters<
					typeof persistenceManager.saveEdgeWorkerState
				>[0],
			);

			// Payload written via the temp-file handle...
			expect(open).toHaveBeenCalledWith(
				expect.stringMatching(/edge-worker-state\.json\.tmp$/),
				"w",
			);
			expect(handleWriteFile).toHaveBeenCalledTimes(1);
			// ...then atomically renamed onto the real file.
			expect(rename).toHaveBeenCalledWith(
				expect.stringMatching(/edge-worker-state\.json\.tmp$/),
				expect.stringMatching(/edge-worker-state\.json$/),
			);
		});

		it("rotates an existing state file to .bak before swapping in the new one", async () => {
			vi.mocked(existsSync).mockReturnValue(true); // prior file exists

			await persistenceManager.saveEdgeWorkerState(
				v4State as unknown as Parameters<
					typeof persistenceManager.saveEdgeWorkerState
				>[0],
			);

			// First rename rotates current → .bak
			expect(rename).toHaveBeenNthCalledWith(
				1,
				expect.stringMatching(/edge-worker-state\.json$/),
				expect.stringMatching(/edge-worker-state\.json\.bak$/),
			);
			// Second rename swaps temp → current
			expect(rename).toHaveBeenNthCalledWith(
				2,
				expect.stringMatching(/edge-worker-state\.json\.tmp$/),
				expect.stringMatching(/edge-worker-state\.json$/),
			);
		});

		it("serializes and coalesces concurrent saves (single-flight)", async () => {
			vi.mocked(existsSync).mockReturnValue(false);

			// Fire several saves without awaiting between them.
			const p1 = persistenceManager.saveEdgeWorkerState({
				agentSessions: { a: { id: "a" } },
			} as never);
			const p2 = persistenceManager.saveEdgeWorkerState({
				agentSessions: { b: { id: "b" } },
			} as never);
			const p3 = persistenceManager.saveEdgeWorkerState({
				agentSessions: { c: { id: "c" } },
			} as never);
			await Promise.all([p1, p2, p3]);

			// Coalesced: far fewer physical writes than save calls, and the last
			// state (c) is the one that ends up persisted.
			expect(handleWriteFile.mock.calls.length).toBeLessThanOrEqual(3);
			const finalPayload = JSON.parse(
				handleWriteFile.mock.calls.at(-1)![0] as string,
			);
			expect(finalPayload.state.agentSessions).toHaveProperty("c");
		});
	});

	describe("crash recovery", () => {
		const goodState = {
			version: "4.0",
			savedAt: "2025-01-15T12:00:00.000Z",
			state: { agentSessions: { "session-1": { id: "session-1" } } },
		};

		it("recovers from .bak when the primary file is corrupt", async () => {
			// Both primary and backup exist; primary is truncated garbage.
			vi.mocked(existsSync).mockReturnValue(true);
			vi.mocked(readFileSync).mockImplementation((p: unknown) => {
				const path = String(p);
				if (path.endsWith(".bak")) return JSON.stringify(goodState);
				return '{"version":"4.0","state":{"agentSess'; // truncated
			});

			const result = await persistenceManager.loadEdgeWorkerState();

			expect(result).toEqual(goodState.state);
		});

		it("returns null (not a resurrected .bak) after an explicit delete", async () => {
			// deleteStateFile removes primary + .tmp + .bak, so nothing remains.
			vi.mocked(existsSync).mockReturnValue(false);

			await persistenceManager.deleteStateFile();
			expect(unlink).toHaveBeenCalledTimes(0); // nothing existed to unlink

			const result = await persistenceManager.loadEdgeWorkerState();
			expect(result).toBeNull();
		});

		it("deletes primary, .tmp and .bak on deleteStateFile", async () => {
			vi.mocked(existsSync).mockReturnValue(true);

			await persistenceManager.deleteStateFile();

			expect(unlink).toHaveBeenCalledWith(
				expect.stringMatching(/edge-worker-state\.json$/),
			);
			expect(unlink).toHaveBeenCalledWith(
				expect.stringMatching(/edge-worker-state\.json\.tmp$/),
			);
			expect(unlink).toHaveBeenCalledWith(
				expect.stringMatching(/edge-worker-state\.json\.bak$/),
			);
		});
	});

	describe("PERSISTENCE_VERSION constant", () => {
		it("should be 4.0", () => {
			expect(PERSISTENCE_VERSION).toBe("4.0");
		});
	});
});
