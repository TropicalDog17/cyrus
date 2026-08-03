import { readFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";

/**
 * The ACP-serializable MCP server entries this catalog produces. The ACP SDK
 * (1.2.1) transport shapes: stdio has no `cwd`/`type` fields, so relative
 * commands are resolved to absolute paths at build time; http/sse have no
 * `type` field. Secrets (headers/env) live in the returned object — they are
 * handed to the OMP process over its stdio ACP session and never written to
 * disk.
 */
export type AcpMcpServer =
	| {
			name: string;
			command: string;
			args?: string[];
			env?: { name: string; value: string }[];
	  }
	| {
			name: string;
			url: string;
			headers?: { name: string; value: string }[];
	  }
	| { name: string; type: "acp"; id: string };

/** A server entry that could not be serialized for ACP, with the reason. */
export interface McpCatalogDiagnostic {
	serverName: string;
	reason: string;
}

export interface ExactMcpCatalogResult {
	/** The exact server map handed to the ACP session. */
	servers: AcpMcpServer[];
	/** Rejected entries — never silently dropped. */
	diagnostics: McpCatalogDiagnostic[];
}

export interface ExactMcpCatalogDeps {
	/** Injectable file reader (tests). */
	readFile?: (path: string) => string;
}

/**
 * Cyrus-owned session servers — final authority, by policy. Repository
 * `.mcp.json` files can never replace or shadow them (ADR 0006): a repo
 * override of `linear` or `cyrus-tools` would otherwise swap Cyrus's managed
 * servers for local ones, changing credentials, permissions, and resume
 * behavior.
 *
 * The effective owned set at build time is this policy set UNION the keys of
 * the inline map (`buildMcpConfig` also injects `slack`/`atlassian` with
 * Cyrus-configured credentials when their env config exists) — every server
 * Cyrus actually injected is authoritative and non-replaceable.
 */
const CYRUS_OWNED_SERVERS: ReadonlySet<string> = new Set([
	"linear",
	"cyrus-tools",
	"cyrus-docs",
]);

/** Normalize a raw header/env record into ACP `{name,value}` pairs. */
function toNameValuePairs(
	raw: unknown,
): { name: string; value: string }[] | undefined {
	if (raw === undefined || raw === null) return undefined;
	if (typeof raw !== "object" || Array.isArray(raw)) return undefined;
	const entries: { name: string; value: string }[] = [];
	for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
		if (typeof value === "string" || typeof value === "number") {
			entries.push({ name: key, value: String(value) });
		}
	}
	return entries;
}

/**
 * Assembles the exact ACP MCP catalog for one session (ADR 0006 / PR 1):
 * Cyrus-owned inline servers merged with the repository's `.mcp.json` files,
 * Cyrus-owned servers winning any name collision. Only ACP-serializable
 * stdio/HTTP/SSE (and ACP id) transports are produced; anything else is
 * reported as a profile-unavailable diagnostic — never silently skipped.
 */
export class ExactMcpCatalog {
	private readonly readFile: (path: string) => string;

	constructor(deps: ExactMcpCatalogDeps = {}) {
		this.readFile =
			deps.readFile ?? ((path: string) => readFileSync(path, "utf8"));
	}

	/**
	 * Build the catalog. `inlineConfig` is the Cyrus-owned server map (from
	 * {@link McpConfigService.buildMcpConfig}); `mcpConfigFiles` are the
	 * repository's `.mcp.json` paths (repo-override vs platform precedence is
	 * resolved by the caller, matching the existing MCP config path rules).
	 */
	build(
		inlineConfig: Record<string, unknown> | undefined,
		mcpConfigFiles: readonly string[] | undefined,
	): ExactMcpCatalogResult {
		const servers: AcpMcpServer[] = [];
		const diagnostics: McpCatalogDiagnostic[] = [];
		// Every server the inline map injected is authoritative (linear,
		// cyrus-tools, cyrus-docs, plus credential-bearing slack/atlassian).
		const owned = new Set<string>([
			...CYRUS_OWNED_SERVERS,
			...Object.keys(inlineConfig ?? {}),
		]);

		// Cyrus-owned inline servers first — final authority over any file.
		for (const [name, raw] of Object.entries(inlineConfig ?? {})) {
			const entry = this.convertEntry(name, raw);
			if (entry) {
				servers.push(entry);
			} else {
				diagnostics.push({
					serverName: name,
					reason: `Cyrus-owned server "${name}" is not ACP-serializable (in-process SDK server or unsupported transport)`,
				});
			}
		}

		// Repository .mcp.json files. Same-name non-Cyrus servers: last file
		// wins (mirrors Claude's merge behavior). Cyrus-owned names are
		// rejected with a diagnostic.
		for (const file of mcpConfigFiles ?? []) {
			const fileServers = this.parseFile(file, diagnostics);
			for (const [name, raw] of Object.entries(fileServers)) {
				// Cyrus-owned names are never replaceable (final authority).
				if (owned.has(name)) {
					diagnostics.push({
						serverName: name,
						reason: `repository override of Cyrus-owned server "${name}" ignored (declared in ${file})`,
					});
					continue;
				}
				const entry = this.convertEntry(name, raw, file);
				if (entry) {
					// Last file wins for non-Cyrus names, mirroring Claude's merge
					// behavior: replace any earlier entry with the same name.
					const existingIndex = servers.findIndex((s) => s.name === name);
					if (existingIndex >= 0) {
						servers[existingIndex] = entry;
					} else {
						servers.push(entry);
					}
				} else {
					diagnostics.push({
						serverName: name,
						reason: `server "${name}" in ${file} is not ACP-serializable (unsupported transport or fields)`,
					});
				}
			}
		}

		return { servers, diagnostics };
	}

	/**
	 * Parse one `.mcp.json` file into a server map. Accepts both the standard
	 * `{mcpServers:{...}}` shape and a flat `{name: config}` map. A missing,
	 * malformed, or non-object file is a diagnostic — never a crash.
	 */
	private parseFile(
		path: string,
		diagnostics: McpCatalogDiagnostic[],
	): Record<string, unknown> {
		let raw: string;
		try {
			raw = this.readFile(path);
		} catch (error) {
			diagnostics.push({
				serverName: path,
				reason: `could not read MCP config file: ${error instanceof Error ? error.message : String(error)}`,
			});
			return {};
		}

		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch {
			diagnostics.push({
				serverName: path,
				reason: `MCP config file is not valid JSON`,
			});
			return {};
		}

		if (
			typeof parsed !== "object" ||
			parsed === null ||
			Array.isArray(parsed)
		) {
			diagnostics.push({
				serverName: path,
				reason: `MCP config file must contain a JSON object`,
			});
			return {};
		}

		const object = parsed as Record<string, unknown>;
		const mcpServers = object.mcpServers;
		if (
			typeof mcpServers === "object" &&
			mcpServers !== null &&
			!Array.isArray(mcpServers)
		) {
			return mcpServers as Record<string, unknown>;
		}
		return object;
	}

	/**
	 * Convert one raw server config into an ACP entry. In-process SDK servers
	 * (closures) and unsupported transports return undefined (the caller emits
	 * the diagnostic). Relative stdio commands resolve against the declaring
	 * file's directory; the ACP stdio transport has no `cwd` field, so the
	 * resolved absolute command is the only correct encoding.
	 */
	private convertEntry(
		name: string,
		raw: unknown,
		declaringFile?: string,
	): AcpMcpServer | undefined {
		if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
			return undefined;
		}
		const cfg = raw as Record<string, unknown>;

		// In-process SDK servers expose closures and cannot cross a process
		// boundary. Reject with a diagnostic — never skip silently.
		if (
			typeof cfg.listTools === "function" ||
			typeof cfg.callTool === "function"
		) {
			return undefined;
		}

		if (typeof cfg.url === "string" && cfg.url.length > 0) {
			const transport = cfg.type;
			if (
				transport !== undefined &&
				transport !== "http" &&
				transport !== "sse"
			) {
				return undefined;
			}
			const headers = toNameValuePairs(cfg.headers);
			return {
				name,
				url: cfg.url,
				...(headers ? { headers } : {}),
			};
		}

		if (typeof cfg.command === "string" && cfg.command.length > 0) {
			const command = this.resolveCommand(cfg.command, declaringFile);
			return {
				name,
				command,
				...(Array.isArray(cfg.args) ? { args: cfg.args.map(String) } : {}),
				...(toNameValuePairs(cfg.env)
					? { env: toNameValuePairs(cfg.env) }
					: {}),
			};
		}

		// ACP id transport (e.g. a locally-running agent as an MCP server).
		if (cfg.type === "acp" && typeof cfg.id === "string") {
			return { name, type: "acp", id: cfg.id };
		}

		return undefined;
	}

	private resolveCommand(command: string, declaringFile?: string): string {
		if (isAbsolute(command) || !declaringFile) {
			return command;
		}
		return join(dirname(declaringFile), command);
	}
}
