import { IssueRelationType } from "@linear/sdk";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, describe, expect, it, vi } from "vitest";

// fs-extra is used only by linear_upload_file (fs.stat / fs.readFile).
// Mock it before importing the module under test so the mocked functions
// are the ones wired into the handler closure.
const { fsStatMock, fsReadFileMock } = vi.hoisted(() => ({
	fsStatMock: vi.fn(),
	fsReadFileMock: vi.fn(),
}));
vi.mock("fs-extra", () => ({
	default: {
		stat: (...args: unknown[]) => fsStatMock(...args),
		readFile: (...args: unknown[]) => fsReadFileMock(...args),
	},
}));

const { createCyrusToolsServer } = await import(
	"../../../src/tools/cyrus-tools/index.js"
);

function getHandler(server: McpServer, name: string) {
	const tools = (
		server as unknown as {
			_registeredTools?: Record<
				string,
				{ handler: (args: any) => Promise<any> }
			>;
		}
	)._registeredTools;
	const t = tools?.[name];
	if (!t) throw new Error(`tool ${name} not registered`);
	return t.handler;
}

function parse(result: any) {
	return JSON.parse(result.content[0].text);
}

/** Bare-bones mock LinearClient covering only the methods the 8 inline
 * cyrus-tools handlers touch. Individual tests override methods as needed. */
function makeLinearClient(overrides: Record<string, any> = {}) {
	return {
		fileUpload: vi.fn(),
		issue: vi.fn(),
		createIssueRelation: vi.fn(),
		agentSessions: vi.fn(),
		agentSession: vi.fn(),
		client: { rawRequest: vi.fn() },
		...overrides,
	} as any;
}

describe("cyrus-tools inline handlers (characterization)", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
		vi.clearAllMocks();
	});

	describe("linear_upload_file", () => {
		it("uploads successfully and returns a COMPACT (no pretty-print) success envelope", async () => {
			fsStatMock.mockResolvedValue({ isFile: () => true, size: 1234 });
			fsReadFileMock.mockResolvedValue(Buffer.from("hello"));
			const linearClient = makeLinearClient({
				fileUpload: vi.fn().mockResolvedValue({
					success: true,
					uploadFile: {
						uploadUrl: "https://upload.example/put",
						assetUrl: "https://asset.example/f.png",
						headers: [{ key: "x-amz-foo", value: "bar" }],
					},
				}),
			});
			const fetchMock = vi.fn().mockResolvedValue({ ok: true });
			vi.stubGlobal("fetch", fetchMock);

			const server = createCyrusToolsServer(linearClient);
			const handler = getHandler(server, "linear_upload_file");
			const result = await handler({ filePath: "/tmp/f.png" });

			expect(result.content[0].text).toBe(
				JSON.stringify({
					success: true,
					assetUrl: "https://asset.example/f.png",
					filename: "f.png",
					size: 1234,
					contentType: "image/png",
				}),
			);

			expect(linearClient.fileUpload).toHaveBeenCalledWith(
				"image/png",
				"f.png",
				1234,
				{ makePublic: undefined },
			);
			const [url, init] = fetchMock.mock.calls[0];
			expect(url).toBe("https://upload.example/put");
			expect(init.method).toBe("PUT");
			expect(init.headers).toEqual({
				"Content-Type": "image/png",
				"Cache-Control": "public, max-age=31536000",
				"x-amz-foo": "bar",
			});
		});

		it.each([
			[".png", "image/png"],
			[".jpg", "image/jpeg"],
			[".jpeg", "image/jpeg"],
			[".gif", "image/gif"],
			[".svg", "image/svg+xml"],
			[".webp", "image/webp"],
			[".bmp", "image/bmp"],
			[".ico", "image/x-icon"],
			[".pdf", "application/pdf"],
			[".doc", "application/msword"],
			[
				".docx",
				"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
			],
			[".xls", "application/vnd.ms-excel"],
			[
				".xlsx",
				"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
			],
			[".ppt", "application/vnd.ms-powerpoint"],
			[
				".pptx",
				"application/vnd.openxmlformats-officedocument.presentationml.presentation",
			],
			[".txt", "text/plain"],
			[".md", "text/markdown"],
			[".csv", "text/csv"],
			[".json", "application/json"],
			[".xml", "application/xml"],
			[".html", "text/html"],
			[".css", "text/css"],
			[".js", "application/javascript"],
			[".ts", "application/typescript"],
			[".zip", "application/zip"],
			[".tar", "application/x-tar"],
			[".gz", "application/gzip"],
			[".rar", "application/vnd.rar"],
			[".7z", "application/x-7z-compressed"],
			[".mp3", "audio/mpeg"],
			[".wav", "audio/wav"],
			[".mp4", "video/mp4"],
			[".mov", "video/quicktime"],
			[".avi", "video/x-msvideo"],
			[".webm", "video/webm"],
			[".log", "text/plain"],
			[".yml", "text/yaml"],
			[".yaml", "text/yaml"],
		])("getMimeType maps %s -> %s", async (ext, expectedType) => {
			fsStatMock.mockResolvedValue({ isFile: () => true, size: 1 });
			fsReadFileMock.mockResolvedValue(Buffer.from("x"));
			const linearClient = makeLinearClient({
				fileUpload: vi.fn().mockResolvedValue({
					success: true,
					uploadFile: {
						uploadUrl: "https://upload.example/put",
						assetUrl: "https://asset.example/f",
						headers: [],
					},
				}),
			});
			vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
			const server = createCyrusToolsServer(linearClient);
			const handler = getHandler(server, "linear_upload_file");
			const result = await handler({ filePath: `/tmp/f${ext}` });
			expect(parse(result).contentType).toBe(expectedType);
		});

		it("falls back to application/octet-stream for an unknown extension", async () => {
			fsStatMock.mockResolvedValue({ isFile: () => true, size: 1 });
			fsReadFileMock.mockResolvedValue(Buffer.from("x"));
			const linearClient = makeLinearClient({
				fileUpload: vi.fn().mockResolvedValue({
					success: true,
					uploadFile: {
						uploadUrl: "https://upload.example/put",
						assetUrl: "https://asset.example/f",
						headers: [],
					},
				}),
			});
			vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
			const server = createCyrusToolsServer(linearClient);
			const handler = getHandler(server, "linear_upload_file");
			const result = await handler({ filePath: "/tmp/f.unknownext" });
			expect(parse(result).contentType).toBe("application/octet-stream");
		});

		it("also falls back to application/octet-stream for a file with no extension", async () => {
			fsStatMock.mockResolvedValue({ isFile: () => true, size: 1 });
			fsReadFileMock.mockResolvedValue(Buffer.from("x"));
			const linearClient = makeLinearClient({
				fileUpload: vi.fn().mockResolvedValue({
					success: true,
					uploadFile: {
						uploadUrl: "https://upload.example/put",
						assetUrl: "https://asset.example/f",
						headers: [],
					},
				}),
			});
			vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
			const server = createCyrusToolsServer(linearClient);
			const handler = getHandler(server, "linear_upload_file");
			const result = await handler({ filePath: "/tmp/Makefile" });
			expect(parse(result).contentType).toBe("application/octet-stream");
		});

		it("returns an error envelope when the path is not a file", async () => {
			fsStatMock.mockResolvedValue({ isFile: () => false });
			const linearClient = makeLinearClient();
			const server = createCyrusToolsServer(linearClient);
			const handler = getHandler(server, "linear_upload_file");
			const result = await handler({ filePath: "/tmp/adir" });
			expect(parse(result)).toEqual({
				success: false,
				error: "Path /tmp/adir is not a file",
			});
		});

		it("returns an error envelope when Linear fails to hand back an upload URL", async () => {
			fsStatMock.mockResolvedValue({ isFile: () => true, size: 1 });
			fsReadFileMock.mockResolvedValue(Buffer.from("x"));
			const linearClient = makeLinearClient({
				fileUpload: vi.fn().mockResolvedValue({ success: false }),
			});
			const server = createCyrusToolsServer(linearClient);
			const handler = getHandler(server, "linear_upload_file");
			const result = await handler({ filePath: "/tmp/f.png" });
			expect(parse(result)).toEqual({
				success: false,
				error: "Failed to get upload URL from Linear",
			});
		});

		it("returns an error envelope when the PUT to the upload URL fails", async () => {
			fsStatMock.mockResolvedValue({ isFile: () => true, size: 1 });
			fsReadFileMock.mockResolvedValue(Buffer.from("x"));
			const linearClient = makeLinearClient({
				fileUpload: vi.fn().mockResolvedValue({
					success: true,
					uploadFile: {
						uploadUrl: "https://upload.example/put",
						assetUrl: "https://asset.example/f",
						headers: [],
					},
				}),
			});
			vi.stubGlobal(
				"fetch",
				vi.fn().mockResolvedValue({
					ok: false,
					status: 403,
					statusText: "Forbidden",
					text: async () => "denied",
				}),
			);
			const server = createCyrusToolsServer(linearClient);
			const handler = getHandler(server, "linear_upload_file");
			const result = await handler({ filePath: "/tmp/f.png" });
			expect(parse(result)).toEqual({
				success: false,
				error: "Failed to upload file: 403 Forbidden - denied",
			});
		});

		it("catches a thrown error (e.g. fs.stat rejects) into an error envelope", async () => {
			fsStatMock.mockRejectedValue(new Error("ENOENT: no such file"));
			const linearClient = makeLinearClient();
			const server = createCyrusToolsServer(linearClient);
			const handler = getHandler(server, "linear_upload_file");
			const result = await handler({ filePath: "/tmp/missing.png" });
			expect(parse(result)).toEqual({
				success: false,
				error: "ENOENT: no such file",
			});
		});
	});

	describe("linear_agent_session_create", () => {
		it("creates a session, returns compact envelope, and does NOT fire onSessionCreated when parentSessionId/onSessionCreated are both absent", async () => {
			const rawRequest = vi.fn().mockResolvedValue({
				data: {
					agentSessionCreateOnIssue: {
						success: true,
						lastSyncId: 42,
						agentSession: { id: "session-1" },
					},
				},
			});
			const linearClient = makeLinearClient({ client: { rawRequest } });
			const server = createCyrusToolsServer(linearClient);
			const handler = getHandler(server, "linear_agent_session_create");
			const result = await handler({ issueId: "ABC-1" });

			expect(result.content[0].text).toBe(
				JSON.stringify({
					success: true,
					agentSessionId: "session-1",
					lastSyncId: 42,
				}),
			);
			expect(rawRequest).toHaveBeenCalledWith(
				expect.stringContaining("AgentSessionCreateOnIssue"),
				{ input: { issueId: "ABC-1" } },
			);
		});

		it("includes externalLink in the mutation input only when provided", async () => {
			const rawRequest = vi.fn().mockResolvedValue({
				data: {
					agentSessionCreateOnIssue: {
						success: true,
						lastSyncId: 1,
						agentSession: { id: "s" },
					},
				},
			});
			const linearClient = makeLinearClient({ client: { rawRequest } });
			const server = createCyrusToolsServer(linearClient);
			const handler = getHandler(server, "linear_agent_session_create");
			await handler({ issueId: "ABC-1", externalLink: "https://x" });
			expect(rawRequest).toHaveBeenCalledWith(expect.any(String), {
				input: { issueId: "ABC-1", externalLink: "https://x" },
			});
		});

		it("fires onSessionCreated ONLY when both options.parentSessionId AND options.onSessionCreated are set", async () => {
			const rawRequest = vi.fn().mockResolvedValue({
				data: {
					agentSessionCreateOnIssue: {
						success: true,
						lastSyncId: 1,
						agentSession: { id: "child-session" },
					},
				},
			});
			const linearClient = makeLinearClient({ client: { rawRequest } });
			const onSessionCreated = vi.fn();

			// both set -> fires
			let server = createCyrusToolsServer(linearClient, {
				parentSessionId: "parent-1",
				onSessionCreated,
			});
			let handler = getHandler(server, "linear_agent_session_create");
			await handler({ issueId: "ABC-1" });
			expect(onSessionCreated).toHaveBeenCalledWith(
				"child-session",
				"parent-1",
			);

			// only parentSessionId -> does not fire
			onSessionCreated.mockClear();
			server = createCyrusToolsServer(linearClient, {
				parentSessionId: "parent-1",
			});
			handler = getHandler(server, "linear_agent_session_create");
			await handler({ issueId: "ABC-1" });
			expect(onSessionCreated).not.toHaveBeenCalled();

			// only onSessionCreated -> does not fire
			server = createCyrusToolsServer(linearClient, { onSessionCreated });
			handler = getHandler(server, "linear_agent_session_create");
			await handler({ issueId: "ABC-1" });
			expect(onSessionCreated).not.toHaveBeenCalled();
		});

		it("returns an error envelope when the mutation reports success:false", async () => {
			const rawRequest = vi.fn().mockResolvedValue({
				data: { agentSessionCreateOnIssue: { success: false } },
			});
			const linearClient = makeLinearClient({ client: { rawRequest } });
			const server = createCyrusToolsServer(linearClient);
			const handler = getHandler(server, "linear_agent_session_create");
			const result = await handler({ issueId: "ABC-1" });
			expect(parse(result)).toEqual({
				success: false,
				error: "Failed to create agent session",
			});
		});

		it("catches a thrown error into an error envelope", async () => {
			const rawRequest = vi.fn().mockRejectedValue(new Error("network down"));
			const linearClient = makeLinearClient({ client: { rawRequest } });
			const server = createCyrusToolsServer(linearClient);
			const handler = getHandler(server, "linear_agent_session_create");
			const result = await handler({ issueId: "ABC-1" });
			expect(parse(result)).toEqual({
				success: false,
				error: "network down",
			});
		});
	});

	describe("linear_agent_session_create_on_comment", () => {
		it("creates a session on a comment and returns a compact envelope", async () => {
			const rawRequest = vi.fn().mockResolvedValue({
				data: {
					agentSessionCreateOnComment: {
						success: true,
						lastSyncId: 7,
						agentSession: { id: "session-c" },
					},
				},
			});
			const linearClient = makeLinearClient({ client: { rawRequest } });
			const server = createCyrusToolsServer(linearClient);
			const handler = getHandler(
				server,
				"linear_agent_session_create_on_comment",
			);
			const result = await handler({ commentId: "comment-1" });
			expect(result.content[0].text).toBe(
				JSON.stringify({
					success: true,
					agentSessionId: "session-c",
					lastSyncId: 7,
				}),
			);
			expect(rawRequest).toHaveBeenCalledWith(
				expect.stringContaining("AgentSessionCreateOnComment"),
				{ input: { commentId: "comment-1" } },
			);
		});

		it("fires onSessionCreated only when both parentSessionId and onSessionCreated are set", async () => {
			const rawRequest = vi.fn().mockResolvedValue({
				data: {
					agentSessionCreateOnComment: {
						success: true,
						lastSyncId: 1,
						agentSession: { id: "child-c" },
					},
				},
			});
			const linearClient = makeLinearClient({ client: { rawRequest } });
			const onSessionCreated = vi.fn();
			const server = createCyrusToolsServer(linearClient, {
				parentSessionId: "parent-c",
				onSessionCreated,
			});
			const handler = getHandler(
				server,
				"linear_agent_session_create_on_comment",
			);
			await handler({ commentId: "comment-1" });
			expect(onSessionCreated).toHaveBeenCalledWith("child-c", "parent-c");
		});

		it("returns an error envelope when the mutation reports success:false", async () => {
			const rawRequest = vi.fn().mockResolvedValue({
				data: { agentSessionCreateOnComment: { success: false } },
			});
			const linearClient = makeLinearClient({ client: { rawRequest } });
			const server = createCyrusToolsServer(linearClient);
			const handler = getHandler(
				server,
				"linear_agent_session_create_on_comment",
			);
			const result = await handler({ commentId: "comment-1" });
			expect(parse(result)).toEqual({
				success: false,
				error: "Failed to create agent session on comment",
			});
		});

		it("catches a thrown error into an error envelope", async () => {
			const rawRequest = vi.fn().mockRejectedValue(new Error("boom"));
			const linearClient = makeLinearClient({ client: { rawRequest } });
			const server = createCyrusToolsServer(linearClient);
			const handler = getHandler(
				server,
				"linear_agent_session_create_on_comment",
			);
			const result = await handler({ commentId: "comment-1" });
			expect(parse(result)).toEqual({ success: false, error: "boom" });
		});
	});

	describe("linear_agent_give_feedback", () => {
		it("returns an error envelope when agentSessionId is missing", async () => {
			const linearClient = makeLinearClient();
			const server = createCyrusToolsServer(linearClient);
			const handler = getHandler(server, "linear_agent_give_feedback");
			const result = await handler({ agentSessionId: "", message: "hi" });
			expect(parse(result)).toEqual({
				success: false,
				error: "agentSessionId is required",
			});
		});

		it("returns an error envelope when message is missing", async () => {
			const linearClient = makeLinearClient();
			const server = createCyrusToolsServer(linearClient);
			const handler = getHandler(server, "linear_agent_give_feedback");
			const result = await handler({
				agentSessionId: "session-1",
				message: "",
			});
			expect(parse(result)).toEqual({
				success: false,
				error: "message is required",
			});
		});

		it("calls onFeedbackDelivery and returns {success:true} (compact)", async () => {
			const onFeedbackDelivery = vi.fn().mockResolvedValue(true);
			const linearClient = makeLinearClient();
			const server = createCyrusToolsServer(linearClient, {
				onFeedbackDelivery,
			});
			const handler = getHandler(server, "linear_agent_give_feedback");
			const result = await handler({
				agentSessionId: "session-1",
				message: "keep going",
			});
			expect(onFeedbackDelivery).toHaveBeenCalledWith(
				"session-1",
				"keep going",
			);
			expect(result.content[0].text).toBe(JSON.stringify({ success: true }));
		});

		it("swallows an onFeedbackDelivery rejection and still returns {success:true}", async () => {
			const onFeedbackDelivery = vi.fn().mockRejectedValue(new Error("down"));
			const consoleErrorSpy = vi
				.spyOn(console, "error")
				.mockImplementation(() => {});
			const linearClient = makeLinearClient();
			const server = createCyrusToolsServer(linearClient, {
				onFeedbackDelivery,
			});
			const handler = getHandler(server, "linear_agent_give_feedback");
			const result = await handler({
				agentSessionId: "session-1",
				message: "keep going",
			});
			expect(parse(result)).toEqual({ success: true });
			expect(consoleErrorSpy).toHaveBeenCalled();
			consoleErrorSpy.mockRestore();
		});

		it("returns {success:true} when no onFeedbackDelivery callback is configured", async () => {
			const linearClient = makeLinearClient();
			const server = createCyrusToolsServer(linearClient);
			const handler = getHandler(server, "linear_agent_give_feedback");
			const result = await handler({
				agentSessionId: "session-1",
				message: "keep going",
			});
			expect(parse(result)).toEqual({ success: true });
		});
	});

	describe("linear_set_issue_relation", () => {
		it("returns an error envelope when the blocking issue is not found", async () => {
			const linearClient = makeLinearClient({
				issue: vi.fn().mockResolvedValue(null),
			});
			const server = createCyrusToolsServer(linearClient);
			const handler = getHandler(server, "linear_set_issue_relation");
			const result = await handler({
				issueId: "A-1",
				relatedIssueId: "A-2",
				type: "blocks",
			});
			expect(parse(result)).toEqual({
				success: false,
				error: "Issue A-1 not found",
			});
		});

		it("returns an error envelope when the related issue is not found", async () => {
			const linearClient = makeLinearClient({
				issue: vi
					.fn()
					.mockResolvedValueOnce({ id: "id-1", identifier: "A-1" })
					.mockResolvedValueOnce(null),
			});
			const server = createCyrusToolsServer(linearClient);
			const handler = getHandler(server, "linear_set_issue_relation");
			const result = await handler({
				issueId: "A-1",
				relatedIssueId: "A-2",
				type: "blocks",
			});
			expect(parse(result)).toEqual({
				success: false,
				error: "Related issue A-2 not found",
			});
		});

		it.each([
			["blocks", IssueRelationType.Blocks],
			["related", IssueRelationType.Related],
			["duplicate", IssueRelationType.Duplicate],
		])("maps relation type %s -> IssueRelationType.%s and returns a compact success envelope", async (type, expectedRelationType) => {
			const createIssueRelation = vi.fn().mockResolvedValue({
				issueRelation: Promise.resolve({ id: "relation-1" }),
			});
			const linearClient = makeLinearClient({
				issue: vi
					.fn()
					.mockResolvedValueOnce({ id: "id-1", identifier: "A-1" })
					.mockResolvedValueOnce({ id: "id-2", identifier: "A-2" }),
				createIssueRelation,
			});
			const server = createCyrusToolsServer(linearClient);
			const handler = getHandler(server, "linear_set_issue_relation");
			const result = await handler({
				issueId: "A-1",
				relatedIssueId: "A-2",
				type,
			});

			expect(createIssueRelation).toHaveBeenCalledWith({
				issueId: "id-1",
				relatedIssueId: "id-2",
				type: expectedRelationType,
			});
			expect(result.content[0].text).toBe(
				JSON.stringify({
					success: true,
					relationId: "relation-1",
					message: `Successfully created '${type}' relation: A-1 ${type} A-2`,
				}),
			);
		});

		it("catches a thrown error into an error envelope", async () => {
			const linearClient = makeLinearClient({
				issue: vi.fn().mockRejectedValue(new Error("linear down")),
			});
			const server = createCyrusToolsServer(linearClient);
			const handler = getHandler(server, "linear_set_issue_relation");
			const result = await handler({
				issueId: "A-1",
				relatedIssueId: "A-2",
				type: "blocks",
			});
			expect(parse(result)).toEqual({
				success: false,
				error: "linear down",
			});
		});
	});

	describe("linear_get_child_issues", () => {
		function makeIssue(overrides: Record<string, any> = {}) {
			return {
				id: "parent-id",
				identifier: "CYPACK-1",
				title: "Parent issue",
				url: "https://linear.app/x/issue/CYPACK-1",
				children: vi.fn().mockResolvedValue({
					nodes: Promise.resolve([]),
				}),
				...overrides,
			};
		}

		it("returns an error envelope when the parent issue is not found", async () => {
			const linearClient = makeLinearClient({
				issue: vi.fn().mockResolvedValue(null),
			});
			const server = createCyrusToolsServer(linearClient);
			const handler = getHandler(server, "linear_get_child_issues");
			const result = await handler({ issueId: "CYPACK-1" });
			expect(parse(result)).toEqual({
				success: false,
				error: "Issue CYPACK-1 not found",
			});
		});

		it("defaults limit=50, includeCompleted=true, includeArchived=false and pretty-prints with null,2", async () => {
			const issue = makeIssue();
			const linearClient = makeLinearClient({
				issue: vi.fn().mockResolvedValue(issue),
			});
			const server = createCyrusToolsServer(linearClient);
			const handler = getHandler(server, "linear_get_child_issues");
			const result = await handler({ issueId: "CYPACK-1" });

			// includeArchived defaults to false, so the archivedAt filter is
			// present even though it was never explicitly requested.
			expect(issue.children).toHaveBeenCalledWith({
				first: 50,
				filter: { archivedAt: { null: true } },
			});
			expect(result.content[0].text).toBe(
				JSON.stringify(
					{
						success: true,
						parentIssue: {
							id: "parent-id",
							identifier: "CYPACK-1",
							title: "Parent issue",
							url: "https://linear.app/x/issue/CYPACK-1",
						},
						childCount: 0,
						children: [],
					},
					null,
					2,
				),
			);
		});

		it.each([
			[0, 1],
			[-5, 1],
			[500, 250],
			[1, 1],
			[250, 250],
			[100, 100],
		])("clamps limit=%s to %s", async (input, expected) => {
			const issue = makeIssue();
			const linearClient = makeLinearClient({
				issue: vi.fn().mockResolvedValue(issue),
			});
			const server = createCyrusToolsServer(linearClient);
			const handler = getHandler(server, "linear_get_child_issues");
			await handler({ issueId: "CYPACK-1", limit: input });
			// includeArchived defaults to false, so the archivedAt filter is
			// always present alongside the clamped `first`.
			expect(issue.children).toHaveBeenCalledWith({
				first: expected,
				filter: { archivedAt: { null: true } },
			});
		});

		it("adds a state filter when includeCompleted is false, and an archivedAt filter when includeArchived is false", async () => {
			const issue = makeIssue();
			const linearClient = makeLinearClient({
				issue: vi.fn().mockResolvedValue(issue),
			});
			const server = createCyrusToolsServer(linearClient);
			const handler = getHandler(server, "linear_get_child_issues");
			await handler({
				issueId: "CYPACK-1",
				includeCompleted: false,
				includeArchived: false,
			});
			expect(issue.children).toHaveBeenCalledWith({
				first: 50,
				filter: {
					state: { type: { neq: "completed" } },
					archivedAt: { null: true },
				},
			});
		});

		it("omits the filter key entirely when includeCompleted=true and includeArchived=true", async () => {
			const issue = makeIssue();
			const linearClient = makeLinearClient({
				issue: vi.fn().mockResolvedValue(issue),
			});
			const server = createCyrusToolsServer(linearClient);
			const handler = getHandler(server, "linear_get_child_issues");
			await handler({
				issueId: "CYPACK-1",
				includeCompleted: true,
				includeArchived: true,
			});
			expect(issue.children).toHaveBeenCalledWith({ first: 50 });
		});

		it("maps child fields including state/assignee fallbacks and archivedAt null handling", async () => {
			const createdAt = new Date("2024-01-01T00:00:00.000Z");
			const updatedAt = new Date("2024-01-02T00:00:00.000Z");
			const child1 = {
				id: "c1",
				identifier: "CYPACK-2",
				title: "Child 1",
				state: Promise.resolve({ name: "In Progress", type: "started" }),
				assignee: Promise.resolve({ id: "u1", name: "Alice" }),
				priority: 2,
				priorityLabel: "High",
				createdAt,
				updatedAt,
				url: "https://linear.app/x/issue/CYPACK-2",
				archivedAt: null,
			};
			const child2 = {
				id: "c2",
				identifier: "CYPACK-3",
				title: "Child 2",
				state: Promise.resolve(null),
				assignee: Promise.resolve(null),
				priority: 0,
				priorityLabel: "No priority",
				createdAt,
				updatedAt,
				url: "https://linear.app/x/issue/CYPACK-3",
				archivedAt: null,
			};
			const issue = makeIssue({
				children: vi.fn().mockResolvedValue({
					nodes: Promise.resolve([child1, child2]),
				}),
			});
			const linearClient = makeLinearClient({
				issue: vi.fn().mockResolvedValue(issue),
			});
			const server = createCyrusToolsServer(linearClient);
			const handler = getHandler(server, "linear_get_child_issues");
			const result = await handler({ issueId: "CYPACK-1" });
			const payload = parse(result);
			expect(payload.children).toEqual([
				{
					id: "c1",
					identifier: "CYPACK-2",
					title: "Child 1",
					state: "In Progress",
					stateType: "started",
					assignee: "Alice",
					assigneeId: "u1",
					priority: 2,
					priorityLabel: "High",
					createdAt: createdAt.toISOString(),
					updatedAt: updatedAt.toISOString(),
					url: "https://linear.app/x/issue/CYPACK-2",
					archivedAt: null,
				},
				{
					id: "c2",
					identifier: "CYPACK-3",
					title: "Child 2",
					state: "Unknown",
					stateType: null,
					assignee: null,
					assigneeId: null,
					priority: 0,
					priorityLabel: "No priority",
					createdAt: createdAt.toISOString(),
					updatedAt: updatedAt.toISOString(),
					url: "https://linear.app/x/issue/CYPACK-3",
					archivedAt: null,
				},
			]);
		});

		it("catches a thrown error into a compact error envelope", async () => {
			const linearClient = makeLinearClient({
				issue: vi.fn().mockRejectedValue(new Error("fetch failed")),
			});
			const server = createCyrusToolsServer(linearClient);
			const handler = getHandler(server, "linear_get_child_issues");
			const result = await handler({ issueId: "CYPACK-1" });
			expect(result.content[0].text).toBe(
				JSON.stringify({ success: false, error: "fetch failed" }),
			);
		});
	});

	describe("linear_get_agent_sessions", () => {
		function makeConnection(sessions: any[], pageInfo: any = {}) {
			return {
				nodes: Promise.resolve(sessions),
				pageInfo: Promise.resolve({
					hasNextPage: false,
					hasPreviousPage: false,
					startCursor: null,
					endCursor: null,
					...pageInfo,
				}),
			};
		}

		it("defaults first=50 and pretty-prints with null,2", async () => {
			const agentSessions = vi.fn().mockResolvedValue(makeConnection([]));
			const linearClient = makeLinearClient({ agentSessions });
			const server = createCyrusToolsServer(linearClient);
			const handler = getHandler(server, "linear_get_agent_sessions");
			const result = await handler({});
			expect(agentSessions).toHaveBeenCalledWith({
				first: 50,
				includeArchived: false,
			});
			expect(result.content[0].text).toBe(
				JSON.stringify(
					{
						success: true,
						count: 0,
						sessions: [],
						pageInfo: {
							hasNextPage: false,
							hasPreviousPage: false,
							startCursor: null,
							endCursor: null,
						},
					},
					null,
					2,
				),
			);
		});

		it("clamps first between 1 and 250, but leaves it unclamped/absent when first=0 (falsy short-circuit)", async () => {
			const agentSessions = vi.fn().mockResolvedValue(makeConnection([]));
			const linearClient = makeLinearClient({ agentSessions });
			const server = createCyrusToolsServer(linearClient);
			const handler = getHandler(server, "linear_get_agent_sessions");

			await handler({ first: 500 });
			expect(agentSessions).toHaveBeenLastCalledWith({
				first: 250,
				includeArchived: false,
			});

			await handler({ first: -5 });
			expect(agentSessions).toHaveBeenLastCalledWith({
				first: 1,
				includeArchived: false,
			});

			// first=0 is falsy, so `first ? clamp(first) : undefined` yields
			// undefined -- the `first` key is omitted from variables entirely,
			// NOT clamped to 1. This is current (load-bearing) behavior.
			await handler({ first: 0 });
			expect(agentSessions).toHaveBeenLastCalledWith({
				includeArchived: false,
			});
		});

		it("clamps last the same falsy-short-circuit way and only sets it when explicitly provided", async () => {
			const agentSessions = vi.fn().mockResolvedValue(makeConnection([]));
			const linearClient = makeLinearClient({ agentSessions });
			const server = createCyrusToolsServer(linearClient);
			const handler = getHandler(server, "linear_get_agent_sessions");

			await handler({ last: 500 });
			expect(agentSessions).toHaveBeenLastCalledWith({
				first: 50,
				last: 250,
				includeArchived: false,
			});

			await handler({ last: 0 });
			expect(agentSessions).toHaveBeenLastCalledWith({
				first: 50,
				includeArchived: false,
			});
		});

		it("passes through after/before/orderBy only when provided", async () => {
			const agentSessions = vi.fn().mockResolvedValue(makeConnection([]));
			const linearClient = makeLinearClient({ agentSessions });
			const server = createCyrusToolsServer(linearClient);
			const handler = getHandler(server, "linear_get_agent_sessions");
			await handler({
				after: "cursor-a",
				before: "cursor-b",
				orderBy: "createdAt",
				includeArchived: true,
			});
			expect(agentSessions).toHaveBeenCalledWith({
				first: 50,
				after: "cursor-a",
				before: "cursor-b",
				includeArchived: true,
				orderBy: "createdAt",
			});
		});

		it("maps session fields with null fallbacks for optional dates/fields", async () => {
			const createdAt = new Date("2024-01-01T00:00:00.000Z");
			const updatedAt = new Date("2024-01-02T00:00:00.000Z");
			const session = {
				id: "s1",
				createdAt,
				updatedAt,
				startedAt: null,
				endedAt: null,
				dismissedAt: null,
				archivedAt: null,
				externalLink: null,
				summary: null,
				plan: null,
				sourceMetadata: null,
			};
			const agentSessions = vi
				.fn()
				.mockResolvedValue(makeConnection([session]));
			const linearClient = makeLinearClient({ agentSessions });
			const server = createCyrusToolsServer(linearClient);
			const handler = getHandler(server, "linear_get_agent_sessions");
			const result = await handler({});
			const payload = parse(result);
			expect(payload.sessions).toEqual([
				{
					id: "s1",
					createdAt: createdAt.toISOString(),
					updatedAt: updatedAt.toISOString(),
					startedAt: null,
					endedAt: null,
					dismissedAt: null,
					archivedAt: null,
					externalLink: null,
					summary: null,
					plan: null,
					sourceMetadata: null,
				},
			]);
		});

		it("catches a thrown error into a compact error envelope", async () => {
			const agentSessions = vi.fn().mockRejectedValue(new Error("gql error"));
			const linearClient = makeLinearClient({ agentSessions });
			const server = createCyrusToolsServer(linearClient);
			const handler = getHandler(server, "linear_get_agent_sessions");
			const result = await handler({});
			expect(result.content[0].text).toBe(
				JSON.stringify({ success: false, error: "gql error" }),
			);
		});
	});

	describe("linear_get_agent_session", () => {
		it("returns an error envelope when the session is not found", async () => {
			const linearClient = makeLinearClient({
				agentSession: vi.fn().mockResolvedValue(null),
			});
			const server = createCyrusToolsServer(linearClient);
			const handler = getHandler(server, "linear_get_agent_session");
			const result = await handler({ sessionId: "missing" });
			expect(parse(result)).toEqual({
				success: false,
				error: "Agent session missing not found",
			});
		});

		it("maps a fully-populated session with all nested relations, pretty-printed with null,2", async () => {
			const createdAt = new Date("2024-01-01T00:00:00.000Z");
			const updatedAt = new Date("2024-01-02T00:00:00.000Z");
			const commentCreatedAt = new Date("2024-01-03T00:00:00.000Z");
			const session = {
				id: "s1",
				createdAt,
				updatedAt,
				startedAt: null,
				endedAt: null,
				dismissedAt: null,
				archivedAt: null,
				externalLink: "https://x",
				summary: "sum",
				plan: "plan",
				sourceMetadata: { foo: "bar" },
				issue: Promise.resolve({
					id: "i1",
					identifier: "CYPACK-1",
					title: "Issue title",
					url: "https://linear.app/x",
					description: "desc",
					priority: 1,
					priorityLabel: "Urgent",
				}),
				creator: Promise.resolve({
					id: "u1",
					name: "Alice",
					email: "alice@example.com",
					displayName: "alice",
				}),
				appUser: Promise.resolve({ id: "app1", name: "Cyrus" }),
				comment: Promise.resolve({
					id: "c1",
					body: "comment body",
					createdAt: commentCreatedAt,
				}),
				sourceComment: Promise.resolve({
					id: "sc1",
					body: "source comment body",
					createdAt: commentCreatedAt,
				}),
				dismissedBy: Promise.resolve({
					id: "u2",
					name: "Bob",
					email: "bob@example.com",
				}),
			};
			const linearClient = makeLinearClient({
				agentSession: vi.fn().mockResolvedValue(session),
			});
			const server = createCyrusToolsServer(linearClient);
			const handler = getHandler(server, "linear_get_agent_session");
			const result = await handler({ sessionId: "s1" });

			expect(result.content[0].text).toBe(
				JSON.stringify(
					{
						success: true,
						session: {
							id: "s1",
							createdAt: createdAt.toISOString(),
							updatedAt: updatedAt.toISOString(),
							startedAt: null,
							endedAt: null,
							dismissedAt: null,
							archivedAt: null,
							externalLink: "https://x",
							summary: "sum",
							plan: "plan",
							sourceMetadata: { foo: "bar" },
							issue: {
								id: "i1",
								identifier: "CYPACK-1",
								title: "Issue title",
								url: "https://linear.app/x",
								description: "desc",
								priority: 1,
								priorityLabel: "Urgent",
							},
							creator: {
								id: "u1",
								name: "Alice",
								email: "alice@example.com",
								displayName: "alice",
							},
							appUser: { id: "app1", name: "Cyrus" },
							comment: {
								id: "c1",
								body: "comment body",
								createdAt: commentCreatedAt.toISOString(),
							},
							sourceComment: {
								id: "sc1",
								body: "source comment body",
								createdAt: commentCreatedAt.toISOString(),
							},
							dismissedBy: {
								id: "u2",
								name: "Bob",
								email: "bob@example.com",
							},
						},
					},
					null,
					2,
				),
			);
		});

		it("nulls out every optional nested relation when absent", async () => {
			const createdAt = new Date("2024-01-01T00:00:00.000Z");
			const updatedAt = new Date("2024-01-02T00:00:00.000Z");
			const session = {
				id: "s1",
				createdAt,
				updatedAt,
				startedAt: null,
				endedAt: null,
				dismissedAt: null,
				archivedAt: null,
				externalLink: null,
				summary: null,
				plan: null,
				sourceMetadata: null,
				issue: Promise.resolve(null),
				creator: Promise.resolve(null),
				appUser: Promise.resolve(null),
				comment: Promise.resolve(null),
				sourceComment: Promise.resolve(null),
				dismissedBy: Promise.resolve(null),
			};
			const linearClient = makeLinearClient({
				agentSession: vi.fn().mockResolvedValue(session),
			});
			const server = createCyrusToolsServer(linearClient);
			const handler = getHandler(server, "linear_get_agent_session");
			const result = await handler({ sessionId: "s1" });
			const payload = parse(result);
			expect(payload.session.issue).toBeNull();
			expect(payload.session.creator).toBeNull();
			expect(payload.session.appUser).toBeNull();
			expect(payload.session.comment).toBeNull();
			expect(payload.session.sourceComment).toBeNull();
			expect(payload.session.dismissedBy).toBeNull();
		});

		it("catches a thrown error into a compact error envelope", async () => {
			const linearClient = makeLinearClient({
				agentSession: vi.fn().mockRejectedValue(new Error("boom")),
			});
			const server = createCyrusToolsServer(linearClient);
			const handler = getHandler(server, "linear_get_agent_session");
			const result = await handler({ sessionId: "s1" });
			expect(result.content[0].text).toBe(
				JSON.stringify({ success: false, error: "boom" }),
			);
		});
	});
});
