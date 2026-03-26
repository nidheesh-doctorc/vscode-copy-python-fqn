#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# ensure-server.sh — Idempotent installer + bootstrap for the host task server.
#
# Downloads server.py from GitHub, installs to a global location, starts
# the server if not already running.
# Safe to call repeatedly (e.g. from devcontainer.json initializeCommand).
#
# Usage in devcontainer.json:
#   "initializeCommand": "curl -fsSL https://raw.githubusercontent.com/nidheesh-doctorc/vscode-copy-python-fqn/main/host-scripts/ensure-server.sh | bash"
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

REPO_RAW="https://raw.githubusercontent.com/nidheesh-doctorc/vscode-copy-python-fqn/main"
PORT="${HOST_TASK_SERVER_PORT:-7890}"
INSTALL_DIR="${HOME}/.local/share/vscode-host-task-server"
INSTALLED_SERVER="${INSTALL_DIR}/server.py"
PID_FILE="${INSTALL_DIR}/server.pid"
TMP_SERVER="${INSTALL_DIR}/server.py.tmp"

# Find python3
PYTHON="$(command -v python3 2>/dev/null || true)"
if [[ -z "${PYTHON}" ]]; then
    echo "[host-task-server] python3 not found, skipping server setup"
    exit 0
fi

# Download/update server.py from GitHub
mkdir -p "${INSTALL_DIR}"
OLD_HASH=""
if [[ -f "${INSTALLED_SERVER}" ]]; then
    OLD_HASH="$(shasum -a 256 "${INSTALLED_SERVER}" | awk '{print $1}')"
fi
if command -v curl &>/dev/null; then
    curl -fsSL "${REPO_RAW}/host-scripts/server.py" -o "${TMP_SERVER}"
elif command -v wget &>/dev/null; then
    wget -qO "${TMP_SERVER}" "${REPO_RAW}/host-scripts/server.py"
else
    echo "[host-task-server] Neither curl nor wget found, cannot download server.py"
    exit 1
fi
mv "${TMP_SERVER}" "${INSTALLED_SERVER}"
echo "[host-task-server] Downloaded server.py to ${INSTALL_DIR}"

NEW_HASH="$(shasum -a 256 "${INSTALLED_SERVER}" | awk '{print $1}')"
SERVER_CHANGED=0
if [[ "${OLD_HASH}" != "${NEW_HASH}" ]]; then
    SERVER_CHANGED=1
fi

# Check if server is already listening
SERVER_RUNNING=0
if command -v curl &>/dev/null; then
    if curl -sf "http://localhost:${PORT}/health" &>/dev/null; then
        SERVER_RUNNING=1
    fi
elif command -v nc &>/dev/null; then
    if nc -z localhost "${PORT}" 2>/dev/null; then
        SERVER_RUNNING=1
    fi
fi

if [[ "${SERVER_RUNNING}" -eq 1 ]]; then
    echo "[host-task-server] Existing server detected on port ${PORT}; restarting"
fi

# Kill stale process if pid file exists
if [[ -f "${PID_FILE}" ]]; then
    OLD_PID=$(cat "${PID_FILE}" 2>/dev/null || true)
    if [[ -n "${OLD_PID}" ]] && kill -0 "${OLD_PID}" 2>/dev/null; then
        kill "${OLD_PID}" 2>/dev/null || true
        sleep 0.5
    fi
    rm -f "${PID_FILE}"
fi

# If a previous server instance is still holding the port, stop it before launch.
if command -v lsof &>/dev/null; then
    PORT_PIDS="$(lsof -tiTCP:"${PORT}" -sTCP:LISTEN 2>/dev/null || true)"
    if [[ -n "${PORT_PIDS}" ]]; then
        echo "[host-task-server] Stopping existing listener(s) on port ${PORT}: ${PORT_PIDS//$'\n'/ }"
        kill ${PORT_PIDS} 2>/dev/null || true
        sleep 0.5

        PORT_PIDS="$(lsof -tiTCP:"${PORT}" -sTCP:LISTEN 2>/dev/null || true)"
        if [[ -n "${PORT_PIDS}" ]]; then
            kill -9 ${PORT_PIDS} 2>/dev/null || true
            sleep 0.5
        fi
    fi
fi

if command -v lsof &>/dev/null && lsof -tiTCP:"${PORT}" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "[host-task-server] ERROR: port ${PORT} is still in use after restart attempt"
    exit 1
fi

# Start server in background, fully detached from this shell session.
# When run via `curl | bash`, the shell exits immediately — we need setsid
# (or disown) to prevent the child from being killed with the session.
LOG_FILE="${INSTALL_DIR}/server.log"
if command -v setsid &>/dev/null; then
    setsid "${PYTHON}" "${INSTALLED_SERVER}" --port "${PORT}" >> "${LOG_FILE}" 2>&1 &
else
    nohup "${PYTHON}" "${INSTALLED_SERVER}" --port "${PORT}" >> "${LOG_FILE}" 2>&1 &
    disown 2>/dev/null || true
fi
echo $! > "${PID_FILE}"

# Give the server a moment to start and verify it's alive
sleep 1
if kill -0 "$(cat "${PID_FILE}")" 2>/dev/null; then
    echo "[host-task-server] Started on port ${PORT} (pid $(cat "${PID_FILE}"))"
else
    echo "[host-task-server] WARNING: process exited immediately. Check ${LOG_FILE}"
fi
echo "[host-task-server] Log: ${LOG_FILE}"
