import type {
	AgentAssistantMessage,
	AgentMessage,
	AgentResultMessage,
	AgentUserMessage,
} from "cyrus-core";
import type { Activity } from "./Activity.js";
import type { MapContext } from "./MapContext.js";

/** The originating tool as recorded for a tool_result lookup. */
interface ToolCall {
	name: string;
	input: unknown;
}

/**
 * Normalize a provider-native tool name + input to the canonical
 * (Claude-shaped) name + input the render table keys on.
 *
 * For `claude` this is identity (names are already canonical). For `cursor`
 * this folds in the mapping that used to live in `CursorRunner.projectToolCall`
 * and its inline mcp extraction (shell -> Bash, read -> Read, mcp ->
 * `mcp__<server>__<tool>`, update_todos -> TodoWrite, web_fetch -> WebFetch,
 * workingDirectory-relative Read path). Already-canonical cursor names (e.g.
 * "Bash", "mcp__linear__x") fall through unchanged, so it is idempotent.
 *
 * Exported so AgentSessionManager can normalize before its state-cache
 * decisions (active Task / TaskCreate subject) — the mapping table lives in one
 * place.
 */
export function normalizeTool(
	provider: "claude" | "cursor" | "codex",
	rawName: string,
	rawInput: unknown,
	workingDirectory?: string,
): ToolCall {
	// Preserve any subtask arrow prefix around the base name.
	let prefix = "";
	let base = rawName;
	if (base.startsWith("↪ ")) {
		prefix = "↪ ";
		base = base.slice(2);
	}

	if (provider !== "cursor") {
		return { name: rawName, input: rawInput };
	}

	const args =
		rawInput && typeof rawInput === "object"
			? (rawInput as Record<string, unknown>)
			: {};
	const lowered = base.toLowerCase();
	let name = base;
	let input: unknown = rawInput;

	if (lowered === "shell") {
		name = "Bash";
		const command = typeof args.command === "string" ? args.command : "";
		input = { command, description: command };
	} else if (lowered === "read") {
		name = "Read";
		input = {
			file_path: typeof args.path === "string" ? args.path : args.file_path,
			offset: args.offset,
			limit: args.limit,
		};
	} else if (lowered === "grep") {
		name = "Grep";
		input = {
			pattern: typeof args.pattern === "string" ? args.pattern : "",
			path: typeof args.path === "string" ? args.path : undefined,
		};
	} else if (lowered === "glob") {
		name = "Glob";
		input = {
			pattern:
				typeof args.globPattern === "string" ? args.globPattern : args.pattern,
			path:
				typeof args.targetDirectory === "string"
					? args.targetDirectory
					: undefined,
		};
	} else if (
		lowered === "edit" ||
		lowered === "write" ||
		lowered === "delete"
	) {
		name =
			lowered === "delete" ? "Edit" : lowered === "write" ? "Write" : "Edit";
		input = { file_path: typeof args.path === "string" ? args.path : "" };
	} else if (lowered === "mcp") {
		const mcpServer =
			typeof args.providerIdentifier === "string"
				? args.providerIdentifier
				: typeof args.server === "string"
					? args.server
					: "mcp";
		const innerTool =
			typeof args.toolName === "string"
				? args.toolName
				: typeof args.name === "string"
					? args.name
					: "tool";
		name = `mcp__${mcpServer}__${innerTool}`;
		input =
			args.args && typeof args.args === "object"
				? (args.args as Record<string, unknown>)
				: {};
	} else if (lowered === "update_todos" || lowered === "updatetodos") {
		name = "TodoWrite";
		input = { todos: args.todos };
	} else if (lowered === "web_fetch" || lowered === "webfetch") {
		name = "WebFetch";
		input = { url: typeof args.url === "string" ? args.url : "" };
	}

	// Light path normalization: trim workingDirectory prefix on read targets.
	if (
		workingDirectory &&
		name === "Read" &&
		input &&
		typeof input === "object" &&
		typeof (input as { file_path?: unknown }).file_path === "string"
	) {
		const filePath = (input as { file_path: string }).file_path;
		if (filePath.startsWith(workingDirectory)) {
			const rel = filePath.slice(workingDirectory.length).replace(/^\//, "");
			if (rel) input = { ...(input as object), file_path: rel };
		}
	}

	return { name: prefix + name, input };
}

/**
 * The single per-tool render table for the agent timeline. Pure: switches on
 * the neutral {@link AgentMessage} union plus a read-only {@link MapContext}
 * snapshot and returns 0..1 {@link Activity} per message.
 *
 * The per-tool string rendering is a VERBATIM port of the former
 * `ClaudeMessageFormatter` (its exact output is asserted by the timeline). The
 * two runner formatters and Cursor's tool-name normalization fold in here; no
 * session state is mutated (all writes stay in AgentSessionManager).
 */
export class ActivityMapper {
	map(msg: AgentMessage, ctx: MapContext): Activity[] {
		switch (msg.type) {
			case "assistant":
				return this.mapAssistant(msg, ctx);
			case "user":
				return this.mapUser(msg, ctx);
			case "result":
				return this.mapResult(msg);
			case "system":
				// Model notification (init) and status handling stay in
				// AgentSessionManager; nothing to render here.
				return [];
			default:
				// rate_limit and any other non-content messages: no activity.
				return [];
		}
	}

	// ---------------------------------------------------------------------------
	// Message mappers
	// ---------------------------------------------------------------------------

	private mapAssistant(
		msg: AgentAssistantMessage,
		ctx: MapContext,
	): Activity[] {
		const toolUse = msg.content.find((b) => b.type === "tool_use");

		if (toolUse && toolUse.type === "tool_use") {
			const { name: baseName, input } = normalizeTool(
				ctx.provider,
				toolUse.name,
				toolUse.input,
				ctx.workingDirectory,
			);

			// Subtask arrow prefix for tools spawned inside an active Task.
			const displayName =
				msg.parentToolUseId && ctx.activeTaskUseId === msg.parentToolUseId
					? `↪ ${baseName}`
					: baseName;

			// AskUserQuestion is custom-handled via the Linear select elicitation.
			if (baseName === "AskUserQuestion") {
				return [];
			}

			// TodoWrite (Claude) / write_todos (legacy) render as a thought.
			if (baseName === "TodoWrite" || baseName === "write_todos") {
				return [
					{
						type: "thought",
						body: this.renderTodoWrite(JSON.stringify(input, null, 2)),
					},
				];
			}

			// TaskCreate / TaskList render as a thought (subject cache is written in ASM).
			if (baseName === "TaskCreate" || baseName === "TaskList") {
				return [
					{ type: "thought", body: this.renderTaskParameter(baseName, input) },
				];
			}

			// TaskUpdate / TaskGet defer to tool_result time (enriched with subject).
			if (baseName === "TaskUpdate" || baseName === "TaskGet") {
				return [];
			}

			// Task (legacy sub-agent) starts an action; active-Task tracking is in ASM.
			if (baseName === "Task") {
				return [
					{
						type: "action",
						action: baseName,
						parameter: this.renderToolParameter(baseName, input),
					},
				];
			}

			// Standard tool: ephemeral action, result filled in at tool_result time.
			return [
				{
					type: "action",
					action: displayName,
					parameter: this.renderToolParameter(displayName, input),
					ephemeral: true,
				},
			];
		}

		// Non-tool assistant turn.
		if (msg.error) {
			// Provider error (rate_limit, billing_error, …) surfaces as an error
			// activity so it is visible to users (CYPACK-719).
			return [{ type: "error", body: this.extractContent(msg) }];
		}

		const body = this.extractContent(msg);
		if (!body.trim()) {
			return [];
		}
		return [{ type: "thought", body }];
	}

	private mapUser(msg: AgentUserMessage, ctx: MapContext): Activity[] {
		const toolResult = msg.content.find((b) => b.type === "tool_result");
		if (!toolResult || toolResult.type !== "tool_result") {
			return [];
		}

		const toolUseId = toolResult.toolUseId;
		const resultContent = toolResult.content;
		const isError = toolResult.isError;

		// A tool_result whose id matches the session's active Task completes it.
		if (ctx.activeTaskUseId && ctx.activeTaskUseId === toolUseId) {
			return [
				{
					type: "thought",
					body: `✅ Task Completed\n\n\n\n${resultContent}\n\n---\n\n`,
				},
			];
		}

		const originalTool = ctx.toolCall(toolUseId);
		const toolName = originalTool?.name || "Tool";
		const toolInput = originalTool?.input || "";
		const baseToolName = toolName.replace("↪ ", "");

		// Enriched TaskUpdate / TaskGet thought (subject resolved via cache in ASM).
		if (baseToolName === "TaskUpdate" || baseToolName === "TaskGet") {
			const enrichedInput: Record<string, unknown> =
				toolInput && typeof toolInput === "object"
					? { ...(toolInput as Record<string, unknown>) }
					: {};
			if (!enrichedInput.subject) {
				const taskId =
					typeof enrichedInput.taskId === "string" ? enrichedInput.taskId : "";
				const cachedSubject = ctx.taskSubjectById(taskId);
				if (cachedSubject) {
					enrichedInput.subject = cachedSubject;
				} else if (
					(baseToolName === "TaskGet" || baseToolName === "TaskUpdate") &&
					resultContent
				) {
					// Parse `Subject:` out of the result content (e.g. TaskGet's
					// "ID: 3\nSubject: Fix bug\nStatus: ..."). The stateful cache
					// write-back lives in AgentSessionManager; this parse enriches
					// the current render.
					const subjectMatch = resultContent.match(/^Subject:\s*(.+)$/m);
					if (subjectMatch?.[1]) {
						enrichedInput.subject = subjectMatch[1].trim();
					}
				}
			}
			return [
				{
					type: "thought",
					body: this.renderTaskParameter(baseToolName, enrichedInput),
				},
			];
		}

		// Tools that already produced a non-ephemeral thought at tool_use time, or
		// are custom-handled, emit no result activity.
		if (
			toolName === "TodoWrite" ||
			toolName === "↪ TodoWrite" ||
			toolName === "write_todos" ||
			toolName === "TaskCreate" ||
			toolName === "↪ TaskCreate" ||
			toolName === "TaskList" ||
			toolName === "↪ TaskList" ||
			toolName === "AskUserQuestion" ||
			toolName === "↪ AskUserQuestion"
		) {
			return [];
		}

		return [
			{
				type: "action",
				action: this.renderToolActionName(toolName, toolInput, isError),
				parameter: this.renderToolParameter(toolName, toolInput),
				result: this.renderToolResult(
					toolName,
					toolInput,
					resultContent?.trim() || "",
					isError,
				),
			},
		];
	}

	private mapResult(msg: AgentResultMessage): Activity[] {
		if (msg.isError) {
			const body = (
				"errors" in msg && Array.isArray(msg.errors) && msg.errors.length > 0
					? msg.errors.join("\n")
					: ""
			).trim();
			return [{ type: "error", body }];
		}
		const body =
			"result" in msg && typeof msg.result === "string" ? msg.result : "";
		return [{ type: "response", body }];
	}

	/**
	 * Flatten a neutral agent message's content blocks to a single string (the
	 * same join the former `AgentSessionManager.extractContent` produced).
	 */
	private extractContent(
		msg: AgentAssistantMessage | AgentUserMessage,
	): string {
		return msg.content
			.map((block) => {
				if (block.type === "text") return block.text;
				if (block.type === "thinking") return block.thinking;
				if (block.type === "tool_use")
					return JSON.stringify(block.input, null, 2);
				if (block.type === "tool_result") return block.content;
				return "";
			})
			.filter(Boolean)
			.join("\n");
	}

	// ===========================================================================
	// RENDER TABLE — verbatim port of ClaudeMessageFormatter. The exact output
	// strings are asserted by the timeline; do not paraphrase.
	// ===========================================================================

	/**
	 * Format TodoWrite tool parameter as a nice checklist.
	 * @deprecated TodoWrite has been replaced by Task tools.
	 */
	private renderTodoWrite(jsonContent: string): string {
		try {
			const data = JSON.parse(jsonContent);
			if (!data.todos || !Array.isArray(data.todos)) {
				return jsonContent;
			}

			const todos = data.todos as Array<{
				id: string;
				content: string;
				status: string;
				priority: string;
			}>;

			// Keep original order but add status indicators
			let formatted = "\n";

			todos.forEach((todo, index) => {
				let statusEmoji = "";
				if (todo.status === "completed") {
					statusEmoji = "✅ ";
				} else if (todo.status === "in_progress") {
					statusEmoji = "🔄 ";
				} else if (todo.status === "pending") {
					statusEmoji = "⏳ ";
				}

				formatted += `${statusEmoji}${todo.content}`;
				if (index < todos.length - 1) {
					formatted += "\n";
				}
			});

			return formatted;
		} catch (error) {
			console.error(
				"[ActivityMapper] Failed to format TodoWrite parameter:",
				error,
			);
			return jsonContent;
		}
	}

	/**
	 * Format Task tool parameter (TaskCreate, TaskUpdate, TaskList, TaskGet).
	 */
	private renderTaskParameter(toolName: string, toolInput: any): string {
		try {
			// If input is already a string, return it
			if (typeof toolInput === "string") {
				return toolInput;
			}

			switch (toolName) {
				case "TaskCreate": {
					// TaskCreate fires in parallel — keep it concise as a pending checklist item
					const subject = toolInput.subject || "";
					return `⏳ **${subject}**`;
				}

				case "TaskUpdate": {
					// TaskUpdate: { taskId, status?, subject? }
					const taskId = toolInput.taskId || "";
					const status = toolInput.status;
					const subject = toolInput.subject || "";

					let statusEmoji = "";
					if (status === "completed") {
						statusEmoji = "✅";
					} else if (status === "in_progress") {
						statusEmoji = "🔄";
					} else if (status === "pending") {
						statusEmoji = "⏳";
					} else if (status === "deleted") {
						statusEmoji = "🗑️";
					}

					if (subject) {
						return `${statusEmoji} Task #${taskId} — ${subject}`;
					}
					return `${statusEmoji} Task #${taskId}`;
				}

				case "TaskGet": {
					// TaskGet: { taskId, subject? }
					const taskId = toolInput.taskId || "";
					const subject = toolInput.subject || "";
					if (subject) {
						return `📋 Task #${taskId} — ${subject}`;
					}
					return `📋 Task #${taskId}`;
				}

				case "TaskList": {
					return "📋 List all tasks";
				}

				default:
					// Fallback for unknown Task tool types
					if (toolInput.subject) {
						return toolInput.subject;
					}
					if (toolInput.description) {
						return toolInput.description;
					}
					return JSON.stringify(toolInput);
			}
		} catch (error) {
			console.error("[ActivityMapper] Failed to format Task parameter:", error);
			return JSON.stringify(toolInput);
		}
	}

	/**
	 * Format tool input for display in agent activities.
	 */
	private renderToolParameter(toolName: string, toolInput: any): string {
		// If input is already a string, return it
		if (typeof toolInput === "string") {
			return toolInput;
		}

		try {
			switch (toolName) {
				case "Bash":
				case "↪ Bash": {
					// Show command only - description goes in action field via renderToolActionName
					return toolInput.command || JSON.stringify(toolInput);
				}

				case "Read":
				case "↪ Read":
					if (toolInput.file_path) {
						let param = toolInput.file_path;
						if (
							toolInput.offset !== undefined ||
							toolInput.limit !== undefined
						) {
							const start = toolInput.offset || 0;
							const end = toolInput.limit ? start + toolInput.limit : "end";
							param += ` (lines ${start + 1}-${end})`;
						}
						return param;
					}
					break;

				case "Edit":
				case "↪ Edit":
					if (toolInput.file_path) {
						return toolInput.file_path;
					}
					break;

				case "Write":
				case "↪ Write":
					if (toolInput.file_path) {
						return toolInput.file_path;
					}
					break;

				case "Grep":
				case "↪ Grep":
					if (toolInput.pattern) {
						let param = `Pattern: \`${toolInput.pattern}\``;
						if (toolInput.path) {
							param += ` in ${toolInput.path}`;
						}
						if (toolInput.glob) {
							param += ` (${toolInput.glob})`;
						}
						if (toolInput.type) {
							param += ` [${toolInput.type} files]`;
						}
						return param;
					}
					break;

				case "Glob":
				case "↪ Glob":
					if (toolInput.pattern) {
						let param = `Pattern: \`${toolInput.pattern}\``;
						if (toolInput.path) {
							param += ` in ${toolInput.path}`;
						}
						return param;
					}
					break;

				case "Task":
				case "↪ Task":
					// Legacy Task tool - deprecated, use specific Task tools instead
					if (toolInput.description) {
						return toolInput.description;
					}
					break;

				case "TaskCreate":
				case "↪ TaskCreate":
				case "TaskUpdate":
				case "↪ TaskUpdate":
				case "TaskGet":
				case "↪ TaskGet":
				case "TaskList":
				case "↪ TaskList":
					// Delegate to renderTaskParameter for Task tools
					return this.renderTaskParameter(
						toolName.replace("↪ ", ""),
						toolInput,
					);

				case "ToolSearch":
				case "↪ ToolSearch": {
					const query: string = toolInput.query || "";
					if (query.startsWith("select:")) {
						const toolNames = query
							.slice("select:".length)
							.split(",")
							.map((name: string) => name.trim())
							.filter((name: string) => name.length > 0);
						if (toolNames.length === 0) {
							return "Loading tool schemas";
						}
						const rendered = toolNames.map((n) => `\`${n}\``).join(", ");
						const label =
							toolNames.length === 1 ? "tool schema" : "tool schemas";
						return `Loading ${label}: ${rendered}`;
					}
					if (!query.trim()) {
						return "Searching tools";
					}
					return `Searching tools for: \`${query}\``;
				}

				case "TaskOutput":
				case "↪ TaskOutput": {
					const taskId = toolInput.task_id || "";
					const block = toolInput.block;
					if (block === false) {
						return `📤 Checking task ${taskId}`;
					}
					return `📤 Waiting for task ${taskId}`;
				}

				case "WebFetch":
				case "↪ WebFetch":
					if (toolInput.url) {
						return toolInput.url;
					}
					break;

				case "WebSearch":
				case "↪ WebSearch":
					if (toolInput.query) {
						return `Query: ${toolInput.query}`;
					}
					break;

				case "NotebookEdit":
				case "↪ NotebookEdit":
					if (toolInput.notebook_path) {
						let param = toolInput.notebook_path;
						if (toolInput.cell_id) {
							param += ` (cell ${toolInput.cell_id})`;
						}
						return param;
					}
					break;

				default:
					// For MCP tools or other unknown tools, try to extract meaningful info
					if (toolName.startsWith("mcp__")) {
						// Extract key fields that are commonly meaningful
						const meaningfulFields = [
							"query",
							"id",
							"issueId",
							"title",
							"name",
							"path",
							"file",
						];
						for (const field of meaningfulFields) {
							if (toolInput[field]) {
								return `${field}: ${toolInput[field]}`;
							}
						}
					}
					break;
			}

			// Fallback to JSON but make it compact
			return JSON.stringify(toolInput);
		} catch (error) {
			console.error("[ActivityMapper] Failed to format tool parameter:", error);
			return JSON.stringify(toolInput);
		}
	}

	/**
	 * Format tool action name with description for Bash tool.
	 */
	private renderToolActionName(
		toolName: string,
		toolInput: any,
		isError: boolean,
	): string {
		// Handle Bash tool with description
		if (toolName === "Bash" || toolName === "↪ Bash") {
			// Check if toolInput has a description field
			if (
				toolInput &&
				typeof toolInput === "object" &&
				"description" in toolInput &&
				toolInput.description
			) {
				const baseName = isError ? `${toolName} (Error)` : toolName;
				return `${baseName} (${toolInput.description})`;
			}
		}

		// Default formatting for other tools or Bash without description
		return isError ? `${toolName} (Error)` : toolName;
	}

	/**
	 * Format tool result for display in agent activities.
	 */
	private renderToolResult(
		toolName: string,
		toolInput: any,
		result: string,
		isError: boolean,
	): string {
		// If there's an error, wrap in error formatting
		if (isError) {
			return `\`\`\`\n${result}\n\`\`\``;
		}

		try {
			switch (toolName) {
				case "Bash":
				case "↪ Bash": {
					// Show command first if not already in parameter
					let formatted = "";
					if (toolInput.command && !toolInput.description) {
						formatted += `\`\`\`bash\n${toolInput.command}\n\`\`\`\n\n`;
					}
					// Then show output
					if (result?.trim()) {
						formatted += `\`\`\`\n${result}\n\`\`\``;
					} else {
						formatted += "*No output*";
					}
					return formatted;
				}

				case "Read":
				case "↪ Read":
					// For Read, the result is file content - use code block
					if (result?.trim()) {
						// Clean up the result: remove line numbers and system-reminder tags
						let cleanedResult = result;

						// Remove line numbers (format: "  123→")
						cleanedResult = cleanedResult.replace(/^\s*\d+→/gm, "");

						// Remove system-reminder blocks
						cleanedResult = cleanedResult.replace(
							/<system-reminder>[\s\S]*?<\/system-reminder>/g,
							"",
						);

						// Trim only blank lines (not horizontal whitespace) to preserve indentation
						cleanedResult = cleanedResult
							.replace(/^\n+/, "")
							.replace(/\n+$/, "");

						// Try to detect language from file extension
						let lang = "";
						if (toolInput.file_path) {
							const ext = toolInput.file_path.split(".").pop()?.toLowerCase();
							const langMap: Record<string, string> = {
								ts: "typescript",
								tsx: "typescript",
								js: "javascript",
								jsx: "javascript",
								py: "python",
								rb: "ruby",
								go: "go",
								rs: "rust",
								java: "java",
								c: "c",
								cpp: "cpp",
								cs: "csharp",
								php: "php",
								swift: "swift",
								kt: "kotlin",
								scala: "scala",
								sh: "bash",
								bash: "bash",
								zsh: "bash",
								yml: "yaml",
								yaml: "yaml",
								json: "json",
								xml: "xml",
								html: "html",
								css: "css",
								scss: "scss",
								md: "markdown",
								sql: "sql",
							};
							lang = langMap[ext || ""] || "";
						}
						return `\`\`\`${lang}\n${cleanedResult}\n\`\`\``;
					}
					return "*Empty file*";

				case "Edit":
				case "↪ Edit": {
					// For Edit, show changes as a diff
					// Extract old_string and new_string from toolInput
					if (toolInput.old_string && toolInput.new_string) {
						// Format as a unified diff
						const oldLines = toolInput.old_string.split("\n");
						const newLines = toolInput.new_string.split("\n");

						let diff = "```diff\n";

						// Add context lines before changes (show all old lines with - prefix)
						for (const line of oldLines) {
							diff += `-${line}\n`;
						}

						// Add new lines with + prefix
						for (const line of newLines) {
							diff += `+${line}\n`;
						}

						diff += "```";

						return diff;
					}

					// Fallback to result if old/new strings not available
					if (result?.trim()) {
						return result;
					}
					return "*Edit completed*";
				}

				case "Write":
				case "↪ Write":
					// For Write, just confirm
					if (result?.trim()) {
						return result; // In case there's an error or message
					}
					return "*File written successfully*";

				case "Grep":
				case "↪ Grep": {
					// Format grep results
					if (result?.trim()) {
						const lines = result.split("\n");
						// If it looks like file paths (files_with_matches mode)
						if (
							lines.length > 0 &&
							lines[0] &&
							!lines[0].includes(":") &&
							lines[0].trim().length > 0
						) {
							return `Found ${lines.filter((l) => l.trim()).length} matching files:\n\`\`\`\n${result}\n\`\`\``;
						}
						// Otherwise it's content matches
						return `\`\`\`\n${result}\n\`\`\``;
					}
					return "*No matches found*";
				}

				case "Glob":
				case "↪ Glob": {
					if (result?.trim()) {
						const lines = result.split("\n").filter((l) => l.trim());
						return `Found ${lines.length} matching files:\n\`\`\`\n${result}\n\`\`\``;
					}
					return "*No files found*";
				}

				case "Task":
				case "↪ Task":
					// Legacy Task tool - deprecated
					if (result?.trim()) {
						if (result.includes("\n")) {
							return `\`\`\`\n${result}\n\`\`\``;
						}
						return result;
					}
					return "*Task completed*";

				case "TaskCreate":
				case "↪ TaskCreate":
					// TaskCreate result typically contains task ID
					if (result?.trim()) {
						return `*Task created*\n${result}`;
					}
					return "*Task created*";

				case "TaskUpdate":
				case "↪ TaskUpdate":
					// TaskUpdate result confirmation
					if (result?.trim()) {
						return result;
					}
					return "*Task updated*";

				case "TaskGet":
				case "↪ TaskGet":
					// TaskGet returns task details - format as code block if multiline
					if (result?.trim()) {
						if (result.includes("\n")) {
							return `\`\`\`\n${result}\n\`\`\``;
						}
						return result;
					}
					return "*No task found*";

				case "TaskList":
				case "↪ TaskList":
					// TaskList returns list of tasks - format as code block
					if (result?.trim()) {
						return `\`\`\`\n${result}\n\`\`\``;
					}
					return "*No tasks*";

				case "ToolSearch":
				case "↪ ToolSearch": {
					const trimmed = result?.trim() ?? "";
					if (!trimmed) {
						return "*No tools found*";
					}
					const lines = trimmed
						.split("\n")
						.map((line) => line.trim())
						.filter((line) => line.length > 0);
					const looksLikeToolNames =
						lines.length > 0 && lines.every((line) => /^[\w.-]+$/.test(line));
					if (looksLikeToolNames) {
						const rendered = lines.map((n) => `\`${n}\``).join(", ");
						const label = lines.length === 1 ? "Loaded tool" : "Loaded tools";
						return `${label}: ${rendered}`;
					}
					return `*${trimmed}*`;
				}

				case "TaskOutput":
				case "↪ TaskOutput":
					// TaskOutput returns background task output
					if (result?.trim()) {
						if (result.includes("\n") && result.length > 100) {
							return `\`\`\`\n${result}\n\`\`\``;
						}
						return result;
					}
					return "*No output yet*";

				case "WebFetch":
				case "↪ WebFetch":
				case "WebSearch":
				case "↪ WebSearch":
					// Web results are usually formatted, keep as is
					return result || "*No results*";

				default:
					// For unknown tools, use code block if result has multiple lines
					if (result?.trim()) {
						if (result.includes("\n") && result.length > 100) {
							return `\`\`\`\n${result}\n\`\`\``;
						}
						return result;
					}
					return "*Completed*";
			}
		} catch (error) {
			console.error("[ActivityMapper] Failed to format tool result:", error);
			return result || "";
		}
	}
}
