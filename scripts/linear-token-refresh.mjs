#!/usr/bin/env node

// Linear OAuth token refresher for Cyrus.
//
// Linear access tokens expire after 24h with a ROTATING refresh token. Cyrus
// also refreshes lazily on 401, but once the access token expires Linear may
// stop delivering agent webhooks, so the lazy path never fires and Cyrus sits
// "idle" while every delegation silently vanishes (root-caused 2026-07-21,
// DEV-186). This timer keeps tokens fresh proactively.
//
// Tokens live in config.json → EdgeWorker ConfigManager hot-reloads and calls
// updateLinearWorkspaceTokens() in-process. No process restart is required.
//
// This script:
//   1. Reads workspaces from ~/.cyrus/config.json (linearWorkspaces) and
//      client credentials (LINEAR_CLIENT_ID/SECRET) from ~/.cyrus/.env.
//   2. Probes each workspace token with a cheap GraphQL viewer query.
//   3. Refreshes when the token is dead (401) or within REFRESH_MARGIN of the
//      expiry recorded in the sidecar (~/.cyrus/linear-token-refresh.json).
//      A workspace with no sidecar entry is refreshed to seed one.
//   4. Persists BOTH rotated tokens back to config.json (atomic write).
//   5. Does NOT restart cyrus.service by default — config hot-reload applies
//      tokens live. Pass --restart only for emergency recovery.
//
// Idempotent + safe on a timer: no-ops while the token is comfortably valid.
// If the refresh token itself is rejected (invalid_grant), it logs that the
// Cyrus Linear OAuth flow must be re-run.
//
// Install: ./scripts/install-token-refresh.sh
// Run:     node ~/.cyrus/linear-token-refresh.mjs [--force] [--restart]

import { execFileSync } from "node:child_process";
import { chmodSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const HOME = homedir();
const CONFIG_PATH = join(HOME, ".cyrus", "config.json");
const ENV_PATH = join(HOME, ".cyrus", ".env");
const STATE_PATH = join(HOME, ".cyrus", "linear-token-refresh.json");
const LOG_PATH = join(HOME, ".cyrus", "linear-token-refresh.log");
const TOKEN_ENDPOINT = "https://api.linear.app/oauth/token";
const GRAPHQL_ENDPOINT = "https://api.linear.app/graphql";
const STATUS_URL = "http://127.0.0.1:3456/status";
const REFRESH_MARGIN_SEC = 3 * 60 * 60; // refresh when <3h of life remains
const BUSY_DEFER_FLOOR_SEC = 30 * 60; // only used with --restart
const FORCE = process.argv.includes("--force");
const WANT_RESTART = process.argv.includes("--restart");
const UID = process.getuid();

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

function readEnvVar(name) {
	let content;
	try {
		content = readFileSync(ENV_PATH, "utf8");
	} catch {
		die(`cannot read ${ENV_PATH}`);
	}
	const m = content.match(new RegExp(`^\\s*${name}\\s*=(.*)$`, "m"));
	return m ? m[1].trim() : null;
}

function readState() {
	try {
		return JSON.parse(readFileSync(STATE_PATH, "utf8"));
	} catch {
		return {};
	}
}

function writeState(state) {
	writeFileSync(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`, {
		mode: 0o600,
	});
	chmodSync(STATE_PATH, 0o600);
}

async function tokenAlive(accessToken) {
	try {
		const res = await fetch(GRAPHQL_ENDPOINT, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${accessToken}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ query: "{ viewer { id } }" }),
			signal: AbortSignal.timeout(15000),
		});
		const body = await res.json().catch(() => ({}));
		return res.ok && !!body?.data?.viewer?.id;
	} catch (e) {
		// Network trouble: treat as alive so we don't burn the rotating refresh
		// token while offline; next hourly run retries.
		log(
			`viewer probe failed (${e.message}) — assuming alive, will retry next run`,
		);
		return true;
	}
}

async function cyrusBusy() {
	try {
		const res = await fetch(STATUS_URL, { signal: AbortSignal.timeout(5000) });
		const body = await res.json();
		return body?.status && body.status !== "idle";
	} catch {
		return false;
	}
}

async function refreshWorkspace(wsId, ws, clientId, clientSecret) {
	const body = new URLSearchParams({
		grant_type: "refresh_token",
		refresh_token: ws.linearRefreshToken,
		client_id: clientId,
		client_secret: clientSecret,
	});
	let res;
	let text;
	try {
		res = await fetch(TOKEN_ENDPOINT, {
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
		die(`token request failed for workspace ${wsId}: ${e.message}`);
	}
	if (!res.ok) {
		die(
			`refresh HTTP ${res.status} for workspace ${wsId}: ${text.slice(0, 300)}\n` +
				`  If this is invalid_grant, the refresh token is dead — re-run the Cyrus\n` +
				`  Linear OAuth flow (cyrus CLI) to re-authorize the workspace.`,
		);
	}
	let fresh;
	try {
		fresh = JSON.parse(text);
	} catch {
		die(`refresh response was not JSON: ${text.slice(0, 200)}`);
	}
	if (!fresh.access_token || !fresh.refresh_token) {
		die(`refresh response missing tokens: ${text.slice(0, 200)}`);
	}
	return fresh;
}

// Re-read config, apply new tokens, atomic-replace. Re-reading just before the
// write keeps the window for clobbering a concurrent Cyrus lazy-refresh small.
function persistTokens(wsId, fresh) {
	const config = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
	if (!config.linearWorkspaces?.[wsId]) {
		die(`workspace ${wsId} vanished from config.json`);
	}
	config.linearWorkspaces[wsId].linearToken = fresh.access_token;
	config.linearWorkspaces[wsId].linearRefreshToken = fresh.refresh_token;
	const tmp = `${CONFIG_PATH}.linear-refresh.tmp`;
	writeFileSync(tmp, `${JSON.stringify(config, null, "\t")}\n`, {
		mode: 0o600,
	});
	renameSync(tmp, CONFIG_PATH);
}

function maybeRestartCyrus() {
	if (!WANT_RESTART) {
		log(
			"hot-reload path: wrote config.json; EdgeWorker ConfigManager will apply tokens (no restart)",
		);
		return;
	}
	try {
		execFileSync("systemctl", ["--user", "restart", "cyrus.service"], {
			env: {
				...process.env,
				XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR || `/run/user/${UID}`,
			},
			stdio: "pipe",
		});
		log(`restarted cyrus.service (--restart)`);
	} catch (e) {
		die(
			`tokens refreshed but 'systemctl --user restart cyrus.service' failed: ${e.message}`,
		);
	}
}

async function main() {
	const clientId = readEnvVar("LINEAR_CLIENT_ID");
	const clientSecret = readEnvVar("LINEAR_CLIENT_SECRET");
	if (!clientId || !clientSecret) {
		die(`LINEAR_CLIENT_ID / LINEAR_CLIENT_SECRET missing from ${ENV_PATH}`);
	}

	let config;
	try {
		config = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
	} catch (e) {
		die(`cannot read/parse ${CONFIG_PATH}: ${e.message}`);
	}
	const workspaces = Object.entries(config.linearWorkspaces || {});
	if (!workspaces.length) die(`no linearWorkspaces in ${CONFIG_PATH}`);

	const state = readState();
	let refreshedAny = false;

	for (const [wsId, ws] of workspaces) {
		const name = ws.linearWorkspaceName || wsId;
		if (!ws.linearRefreshToken) {
			log(
				`workspace ${name}: no refresh token — skipping (re-run Cyrus Linear OAuth to fix)`,
			);
			continue;
		}

		const expiresAtMs = state[wsId]?.expiresAtMs ?? 0;
		const remainingSec = Math.round((expiresAtMs - Date.now()) / 1000);
		const alive = await tokenAlive(ws.linearToken);
		const nearExpiry = remainingSec < REFRESH_MARGIN_SEC; // covers "no sidecar entry" too
		log(
			`workspace ${name}: alive=${alive} tracked-remaining=${expiresAtMs ? `${remainingSec}s` : "unknown"}`,
		);

		if (!FORCE && alive && !nearExpiry) {
			log(`workspace ${name}: still comfortably valid; nothing to do`);
			continue;
		}

		// Only defer when --restart would kill live sessions.
		if (
			WANT_RESTART &&
			!FORCE &&
			alive &&
			(await cyrusBusy()) &&
			remainingSec > BUSY_DEFER_FLOOR_SEC
		) {
			log(
				`workspace ${name}: cyrus busy and ${remainingSec}s left — deferring --restart to next run`,
			);
			continue;
		}

		log(
			`workspace ${name}: refreshing (${FORCE ? "forced" : alive ? "near expiry" : "token dead"})`,
		);
		const fresh = await refreshWorkspace(wsId, ws, clientId, clientSecret);
		persistTokens(wsId, fresh);
		state[wsId] = {
			expiresAtMs: Date.now() + (Number(fresh.expires_in) || 24 * 3600) * 1000,
			refreshedAt: new Date().toISOString(),
		};
		writeState(state);
		refreshedAny = true;
		log(
			`workspace ${name}: new tokens persisted (expires_in ${fresh.expires_in}s)`,
		);
	}

	if (!refreshedAny) return;

	maybeRestartCyrus();
	log(`refresh complete ✅`);
}

main().catch((e) => die(e?.stack || String(e)));
