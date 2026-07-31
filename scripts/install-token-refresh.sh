#!/usr/bin/env bash
# Install ops token-refresh scripts into ~/.cyrus and point systemd user units
# at them. Safe to re-run (idempotent).
#
# Why: the previous copies under ~/.cyrus always `systemctl restart cyrus.service`
# after writing tokens. That drops Linear webhooks for several seconds and has
# caused Linear to disable the OAuth app after repeated delivery failures.
# Canonical scripts in this repo hot-reload via .env / config.json watchers.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST_DIR="${HOME}/.cyrus"
UNIT_DIR="${HOME}/.config/systemd/user"
NODE_BIN="${NODE_BIN:-$(command -v node)}"

if [[ -z "${NODE_BIN}" || ! -x "${NODE_BIN}" ]]; then
  echo "error: node not found on PATH" >&2
  exit 1
fi

mkdir -p "${DEST_DIR}" "${UNIT_DIR}"

install -m 0755 \
  "${REPO_ROOT}/scripts/atlassian-token-refresh.mjs" \
  "${DEST_DIR}/atlassian-token-refresh.mjs"
install -m 0755 \
  "${REPO_ROOT}/scripts/linear-token-refresh.mjs" \
  "${DEST_DIR}/linear-token-refresh.mjs"

# User oneshot units — no restart in Description; ExecStart uses installed copies.
cat > "${UNIT_DIR}/atlassian-token-refresh.service" <<EOF
[Unit]
Description=Refresh Cyrus Atlassian MCP OAuth token (hot-reload .env, no restart)
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
# Self-gating: no-ops unless the token is within ~90min of expiry (or --force).
ExecStart=${NODE_BIN} ${DEST_DIR}/atlassian-token-refresh.mjs
EOF

cat > "${UNIT_DIR}/atlassian-token-refresh.timer" <<'EOF'
[Unit]
Description=Hourly check to keep Cyrus Atlassian MCP OAuth token fresh

[Timer]
OnBootSec=5min
OnUnitActiveSec=1h
Persistent=true

[Install]
WantedBy=timers.target
EOF

cat > "${UNIT_DIR}/linear-token-refresh.service" <<EOF
[Unit]
Description=Refresh Cyrus Linear OAuth tokens (hot-reload config.json, no restart)
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
# Self-gating: no-ops while tokens are comfortably valid (or --force).
ExecStart=${NODE_BIN} ${DEST_DIR}/linear-token-refresh.mjs
EOF

cat > "${UNIT_DIR}/linear-token-refresh.timer" <<'EOF'
[Unit]
Description=Hourly check to keep Cyrus Linear OAuth tokens fresh

[Timer]
OnBootSec=5min
OnUnitActiveSec=1h
Persistent=true

[Install]
WantedBy=timers.target
EOF

systemctl --user daemon-reload
systemctl --user enable --now atlassian-token-refresh.timer linear-token-refresh.timer

echo "Installed:"
echo "  ${DEST_DIR}/atlassian-token-refresh.mjs"
echo "  ${DEST_DIR}/linear-token-refresh.mjs"
echo "  ${UNIT_DIR}/atlassian-token-refresh.{service,timer}"
echo "  ${UNIT_DIR}/linear-token-refresh.{service,timer}"
echo
echo "Timers:"
systemctl --user list-timers '*-token-refresh.timer' --no-pager || true
echo
echo "Note: deploy a Cyrus build that includes debounced .env hot-reload"
echo "(apps/cli Application.ts) so ATLASSIAN_MCP_TOKEN picks up without restart."
