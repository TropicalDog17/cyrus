#!/usr/bin/env node
// Atlassian remote-MCP OAuth token refresher for Cyrus.
//
// The official Atlassian remote MCP server (mcp.atlassian.com) issues short-lived
// OAuth access tokens (~8h) with a rotating refresh token. Cyrus injects
// ATLASSIAN_MCP_TOKEN into per-session MCP config via process.env
// (buildAtlassianMcpServerConfig). The CLI watches ~/.cyrus/.env and hot-reloads
// dotenv into process.env.
//
// This script NEVER restarts cyrus.service — a restart drops Linear webhooks
// and has caused Linear to disable the OAuth app after repeated delivery failures.
//
// This script:
//   1. Finds the newest mcp-remote token cache under ~/.mcp-auth.
//   2. If the access token is within REFRESH_MARGIN of expiry (or --force),
//      exchanges the refresh_token for a fresh access token at the token endpoint.
//   3. Persists the new tokens back to the cache (refresh tokens ROTATE — must save).
//   4. Atomically rewrites ATLASSIAN_MCP_TOKEN in ~/.cyrus/.env (mode 600).
//   5. Stops. The .env watcher hot-reloads. No systemctl.
//
// Idempotent + safe to run on a timer: it no-ops when the token is still
// comfortably valid. If the refresh_token itself has expired, it logs a clear
// error telling the user to re-run the mcp-remote browser flow.
//
// Install: ./scripts/install-token-refresh.sh
// Run:     node ~/.cyrus/atlassian-token-refresh.mjs [--force]

import {
	chmodSync,
	readdirSync,
	readFileSync,
	renameSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const HOME = homedir();
const ENV_PATH = join(HOME, ".cyrus", ".env");
const LOG_PATH = join(HOME, ".cyrus", "atlassian-token-refresh.log");
const MCP_AUTH_DIR = join(HOME, ".mcp-auth");
const AS_METADATA_URL =
	"https://mcp.atlassian.com/.well-known/oauth-authorization-server";
const FALLBACK_TOKEN_ENDPOINT = "https://cf.mcp.atlassian.com/v1/token";
const REFRESH_MARGIN_SEC = 90 * 60; // refresh when <90min of life remains
const FORCE = process.argv.includes("--force");

function log(msg) {
	const line = `${new Date().toISOString()} ${msg}`;
	console.log(line);
	try {
		writeFileSync(LOG_PATH, `${line}\n`, { flag: "a" });
	} catch {
		// ignore log write failures
	}
}

function die(msg) {
	log(`ERROR: ${msg}`);
	process.exit(1);
}

function findTokenFile() {
	let best = null;
	let bestMtime = 0;
	let dirs;
	try {
		dirs = readdirSync(MCP_AUTH_DIR, { withFileTypes: true })
			.filter((d) => d.isDirectory())
			.map((d) => join(MCP_AUTH_DIR, d.name));
	} catch {
		die(`no ~/.mcp-auth dir — run the mcp-remote OAuth flow first`);
	}
	for (const dir of dirs) {
		let files;
		try {
			files = readdirSync(dir);
		} catch {
			continue;
		}
		for (const f of files) {
			if (!f.endsWith("_tokens.json")) continue;
			const p = join(dir, f);
			const m = statSync(p).mtimeMs;
			if (m > bestMtime) {
				bestMtime = m;
				best = {
					path: p,
					dir,
					prefix: f.replace(/_tokens\.json$/, ""),
					mtimeMs: m,
				};
			}
		}
	}
	if (!best) {
		die(
			`no *_tokens.json under ~/.mcp-auth — run the mcp-remote OAuth flow first`,
		);
	}
	return best;
}

async function discoverTokenEndpoint() {
	try {
		const res = await fetch(AS_METADATA_URL, {
			signal: AbortSignal.timeout(12000),
		});
		if (res.ok) {
			const meta = await res.json();
			if (meta.token_endpoint) return meta.token_endpoint;
		}
	} catch {
		// fall through
	}
	log(
		`could not discover token_endpoint; using fallback ${FALLBACK_TOKEN_ENDPOINT}`,
	);
	return FALLBACK_TOKEN_ENDPOINT;
}

function updateEnvToken(token) {
	let lines = [];
	try {
		lines = readFileSync(ENV_PATH, "utf8").split("\n");
	} catch {
		die(`cannot read ${ENV_PATH}`);
	}
	let replaced = false;
	lines = lines.map((l) => {
		if (/^\s*ATLASSIAN_MCP_TOKEN\s*=/.test(l)) {
			replaced = true;
			return `ATLASSIAN_MCP_TOKEN=${token}`;
		}
		return l;
	});
	if (!replaced) {
		while (lines.length && lines[lines.length - 1].trim() === "") lines.pop();
		lines.push(`ATLASSIAN_MCP_TOKEN=${token}`);
	}
	// Atomic replace so the .env watcher sees a single consistent file.
	const tmp = `${ENV_PATH}.atlassian-refresh.tmp`;
	writeFileSync(tmp, `${lines.join("\n")}\n`, { mode: 0o600 });
	chmodSync(tmp, 0o600);
	renameSync(tmp, ENV_PATH);
	chmodSync(ENV_PATH, 0o600);
}

async function main() {
	const tf = findTokenFile();
	const tokens = JSON.parse(readFileSync(tf.path, "utf8"));
	if (!tokens.refresh_token) die(`token cache ${tf.path} has no refresh_token`);

	// expiry = cache mtime + expires_in (Atlassian cache stores no absolute exp)
	const expiresInSec = Number(tokens.expires_in) || 0;
	const expiresAtMs = tf.mtimeMs + expiresInSec * 1000;
	const remainingSec = Math.round((expiresAtMs - Date.now()) / 1000);
	log(
		`token remaining ~${remainingSec}s (expires ${new Date(expiresAtMs).toISOString()})`,
	);

	if (!FORCE && remainingSec > REFRESH_MARGIN_SEC) {
		log(`still valid (> ${REFRESH_MARGIN_SEC}s margin); nothing to do`);
		return;
	}

	// Always refresh when near expiry — hot-reload is non-disruptive; no busy-defer.
	const clientInfo = JSON.parse(
		readFileSync(join(tf.dir, `${tf.prefix}_client_info.json`), "utf8"),
	);
	const clientId = clientInfo.client_id;
	if (!clientId) die(`no client_id in ${tf.prefix}_client_info.json`);

	const tokenEndpoint = await discoverTokenEndpoint();
	log(`refreshing via ${tokenEndpoint} (client ${clientId})`);

	const body = new URLSearchParams({
		grant_type: "refresh_token",
		client_id: clientId,
		refresh_token: tokens.refresh_token,
	});
	// Public client (token_endpoint_auth_method: none) — no secret. Include if present.
	if (clientInfo.client_secret)
		body.set("client_secret", clientInfo.client_secret);

	let res;
	let text;
	try {
		res = await fetch(tokenEndpoint, {
			method: "POST",
			headers: {
				"Content-Type": "application/x-www-form-urlencoded",
				Accept: "application/json",
			},
			body,
			signal: AbortSignal.timeout(20000),
		});
		text = await res.text();
	} catch (e) {
		die(`token request failed: ${e.message}`);
	}
	if (!res.ok) {
		die(
			`refresh HTTP ${res.status}: ${text.slice(0, 300)}\n` +
				`  If this is invalid_grant, the refresh token expired — re-run:\n` +
				`  npx -y mcp-remote@latest https://mcp.atlassian.com/v1/mcp`,
		);
	}

	let fresh;
	try {
		fresh = JSON.parse(text);
	} catch {
		die(`refresh response was not JSON: ${text.slice(0, 200)}`);
	}
	if (!fresh.access_token) {
		die(`refresh response missing access_token: ${text.slice(0, 200)}`);
	}

	// Persist rotated tokens back to the cache (refresh token rotates!)
	const merged = {
		...tokens,
		access_token: fresh.access_token,
		token_type: fresh.token_type || tokens.token_type,
		expires_in: fresh.expires_in != null ? fresh.expires_in : tokens.expires_in,
		scope: fresh.scope || tokens.scope,
		refresh_token: fresh.refresh_token || tokens.refresh_token,
	};
	writeFileSync(tf.path, `${JSON.stringify(merged, null, 2)}\n`, {
		mode: 0o600,
	});
	chmodSync(tf.path, 0o600);

	updateEnvToken(fresh.access_token);
	log(
		`new access token written (${fresh.access_token.length} chars, expires_in ${merged.expires_in}s)`,
	);
	log(
		"hot-reload path: wrote .env; cyrus .env watcher picks up ATLASSIAN_MCP_TOKEN (never restarts cyrus)",
	);
	log(`refresh complete ✅`);
}

main().catch((e) => die(e?.stack || String(e)));
