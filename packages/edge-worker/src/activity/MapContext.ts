/**
 * Read-only snapshot of the session state that {@link ActivityMapper.map}
 * consults, passed in so the mapper stays pure. It carries exactly the tool-use
 * lookups the old per-tool switch read from mutable maps in
 * AgentSessionManager; every WRITE to those maps stays in AgentSessionManager
 * and happens BEFORE the snapshot is built for a given message.
 */
export interface MapContext {
	/**
	 * Selects tool-name normalization: cursor-native (shell/read/grep…) ->
	 * canonical (Bash/Read/Grep…). Comes from the Phase-B
	 * `IAgentRunner.provider` tag (no more `constructor.name` sniff).
	 */
	provider: "claude" | "cursor";
	/**
	 * The originating tool_use for a tool_result's `tool_use_id`.
	 * Old: `this.toolCallsByToolUseId.get(id)`.
	 */
	toolCall(toolUseId: string): { name: string; input: unknown } | undefined;
	/**
	 * The `tool_use_id` of the session's active Task (Task tool), if any.
	 * Old: `activeTasksBySession.get(sessionId)`.
	 */
	activeTaskUseId?: string;
	/**
	 * Cached Task subject by task id, for TaskUpdate/TaskGet enrichment.
	 * Old: `taskSubjectsById.get(taskId)`.
	 */
	taskSubjectById(taskId: string): string | undefined;
	/**
	 * The session's working directory, used to render Cursor `read` targets as
	 * workspace-relative paths (folded in from CursorRunner.projectToolCall's
	 * light path normalization). Undefined for claude sessions / when unknown.
	 */
	workingDirectory?: string;
}
