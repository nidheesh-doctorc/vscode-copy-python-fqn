#!/usr/bin/env python3
"""
Host Task Server — a single global server running on the host machine.
Accepts the workspace path per-request, reads that workspace's
.vscode/tasks.json, and runs tasks prefixed with "Host:".

Works with multiple workspaces and worktrees — install once, serves all.

Endpoints:
    GET  /health                          — liveness check
    POST /tasks   {"workspace": "..."}    — list host tasks for a workspace
    POST /run     {"workspace": "...", "label": "Host: ...", "args": [...]}

Usage:
    python3 host-scripts/server.py [--port 7890]
"""

import argparse
import json
import os
import re
import subprocess
import time
from http.server import HTTPServer, BaseHTTPRequestHandler
from pathlib import Path
from urllib.parse import urlparse

DEFAULT_PORT = 7890
TASK_TYPE = "hostScript"
INPUT_PATTERN = re.compile(r"\$\{(?:input|hostInput):([^}]+)\}")
ENV_PATTERN = re.compile(r"\$\{env:([^}]+)\}")


def strip_jsonc_comments(text: str) -> str:
    """Strip // and /* */ comments from JSONC content."""
    result = []
    i = 0
    in_string = False
    escape = False

    while i < len(text):
        ch = text[i]
        nxt = text[i + 1] if i + 1 < len(text) else ""

        if in_string:
            result.append(ch)
            if escape:
                escape = False
            elif ch == "\\":
                escape = True
            elif ch == '"':
                in_string = False
            i += 1
            continue

        if ch == '"':
            in_string = True
            result.append(ch)
            i += 1
            continue

        if ch == "/" and nxt == "/":
            while i < len(text) and text[i] != "\n":
                i += 1
            continue

        if ch == "/" and nxt == "*":
            i += 2
            while i < len(text) - 1:
                if text[i] == "*" and text[i + 1] == "/":
                    i += 2
                    break
                i += 1
            continue

        result.append(ch)
        i += 1

    cleaned = "".join(result)
    cleaned = re.sub(r",\s*([}\]])", r"\1", cleaned)
    return cleaned


def validate_workspace(workspace: str) -> str | None:
    """Validate workspace path is a real directory. Returns resolved path or None."""
    resolved = os.path.realpath(os.path.expanduser(workspace))
    if not os.path.isdir(resolved):
        return None
    return resolved


def load_host_tasks(workspace: str) -> tuple[list[dict], list[dict]]:
    """Read .vscode/tasks.json from workspace and return type=hostScript tasks + inputs."""
    tasks_path = Path(workspace) / ".vscode" / "tasks.json"
    if not tasks_path.exists():
        return [], []

    raw = tasks_path.read_text(encoding="utf-8")
    data = json.loads(strip_jsonc_comments(raw))
    all_tasks = data.get("tasks", [])
    inputs = data.get("inputs", [])

    host_tasks = []
    for task in all_tasks:
        if task.get("type") == TASK_TYPE:
            host_tasks.append(
                {
                    "label": task.get("label", ""),
                    "command": task.get("command", ""),
                    "args": task.get("args", []),
                    "options": task.get("options", {}),
                }
            )
    return host_tasks, inputs


def replace_input_patterns(value: str, inputs: dict[str, str] | None) -> str:
    """Replace ${input:NAME} and ${hostInput:NAME} placeholders."""
    if not inputs:
        return value
    return INPUT_PATTERN.sub(lambda match: inputs.get(match.group(1), match.group(0)), value)


def replace_env_patterns(value: str, env: dict[str, str]) -> str:
    """Replace ${env:NAME} placeholders using the host environment."""
    return ENV_PATTERN.sub(lambda match: env.get(match.group(1), match.group(0)), value)


def expand_task_value(
    value: str,
    workspace: str,
    env: dict[str, str],
    inputs: dict[str, str] | None = None,
) -> str:
    """Expand VS Code-style placeholders used by host tasks."""
    expanded = value.replace("${workspaceFolder}", workspace)
    expanded = replace_input_patterns(expanded, inputs)
    return replace_env_patterns(expanded, env)


def run_task(
    task: dict,
    extra_args: list[str],
    workspace: str,
    inputs: dict[str, str] | None = None,
    resolved_command: str | None = None,
    resolved_args: list[str] | None = None,
    resolved_env: dict[str, str] | None = None,
) -> dict:
    """Execute a task's shell command on the host and return the result."""
    options = task.get("options", {})
    cwd = options.get("cwd", workspace)
    env = os.environ.copy()
    env_vars = options.get("env", {})
    for k, v in env_vars.items():
        env[k] = expand_task_value(str(v), workspace, env, inputs)
    if resolved_env:
        for key, value in resolved_env.items():
            env[key] = expand_task_value(str(value), workspace, env, inputs)
    for i, arg in enumerate(extra_args, 1):
        env[f"ARG{i}"] = str(arg)

    cwd = expand_task_value(str(cwd), workspace, env, inputs)

    if resolved_command:
        # Extension resolved command/args already.
        if resolved_args is not None:
            command_argv = [resolved_command, *resolved_args, *extra_args]
            command_argv = [expand_task_value(str(part), workspace, env, inputs) for part in command_argv]
            print("  Using resolved argv from extension")
            print(f"  Argv: {command_argv}")
        else:
            full_command = expand_task_value(str(resolved_command), workspace, env, inputs)
            print("  Using resolved command from extension")
    else:
        command = task.get("command", "")
        task_args = task.get("args", [])

        command = expand_task_value(str(command), workspace, env, inputs)
        task_args = [expand_task_value(str(arg), workspace, env, inputs) for arg in task_args]
        extra_args = [expand_task_value(str(arg), workspace, env, inputs) for arg in extra_args]

        parts = [command] + task_args + extra_args
        full_command = " ".join(parts)

    print(f"  Cwd: {cwd}")
    print(f" Env: { {k: env[k] for k in sorted(env_vars.keys())} }")

    if not (resolved_command and resolved_args is not None):
        full_command = full_command.replace("${workspaceFolder}", workspace)
        print(f"  Command: {full_command}")

    timeout = 600

    try:
        if resolved_command and resolved_args is not None:
            proc = subprocess.run(
                command_argv,
                shell=False,
                capture_output=True,
                text=True,
                timeout=timeout,
                cwd=cwd,
                env=env,
            )
        else:
            proc = subprocess.run(
                full_command,
                shell=True,
                capture_output=True,
                text=True,
                timeout=timeout,
                cwd=cwd,
                env=env,
            )
        return {
            "success": proc.returncode == 0,
            "exitCode": proc.returncode,
            "output": proc.stdout,
            "error": proc.stderr,
        }
    except subprocess.TimeoutExpired:
        return {
            "success": False,
            "exitCode": -1,
            "output": "",
            "error": f"Task timed out after {timeout}s",
        }
    except Exception as e:
        return {
            "success": False,
            "exitCode": -1,
            "output": "",
            "error": str(e),
        }


class TaskHandler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        timestamp = time.strftime("%H:%M:%S")
        print(f"  [{timestamp}] {format % args}")

    def _send_json(self, status: int, data: dict):
        body = json.dumps(data).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _read_json_body(self) -> dict | None:
        content_length = int(self.headers.get("Content-Length", 0))
        if content_length == 0:
            self._send_json(400, {"error": "Empty request body"})
            return None
        raw = self.rfile.read(content_length)
        try:
            return json.loads(raw)
        except json.JSONDecodeError:
            self._send_json(400, {"error": "Invalid JSON"})
            return None

    def _get_workspace(self, request: dict) -> str | None:
        workspace = request.get("workspace", "")
        if not workspace:
            self._send_json(400, {"error": "'workspace' path is required"})
            return None
        resolved = validate_workspace(workspace)
        if resolved is None:
            self._send_json(400, {"error": f"Workspace not found: {workspace}"})
            return None
        return resolved

    def do_GET(self):
        if self.path == "/health":
            self._send_json(200, {"status": "ok", "timestamp": time.time()})
            return
        self._send_json(404, {"error": "Not found"})

    def do_POST(self):
        parsed = urlparse(self.path)

        if parsed.path == "/tasks":
            request = self._read_json_body()
            if request is None:
                return
            workspace = self._get_workspace(request)
            if workspace is None:
                return
            tasks, inputs = load_host_tasks(workspace)
            self._send_json(
                200,
                {
                    "workspace": workspace,
                    "tasks": [
                        {
                            "label": t["label"],
                            "command": t["command"],
                            "args": t["args"],
                            "options": t["options"],
                        }
                        for t in tasks
                    ],
                    "inputs": inputs,
                },
            )
            return

        if parsed.path == "/run":
            request = self._read_json_body()
            if request is None:
                return
            workspace = self._get_workspace(request)
            if workspace is None:
                return

            label = request.get("label", "")
            extra_args = request.get("args", [])
            input_values = request.get("inputs", {})
            resolved_command = request.get("resolvedCommand", None)
            resolved_args = request.get("resolvedArgs", None)
            resolved_env = request.get("resolvedEnv", None)

            if not label:
                self._send_json(400, {"error": "'label' is required"})
                return

            if not isinstance(extra_args, list) or not all(
                isinstance(a, str) for a in extra_args
            ):
                self._send_json(400, {"error": "'args' must be an array of strings"})
                return

            if not isinstance(input_values, dict):
                self._send_json(400, {"error": "'inputs' must be an object"})
                return

            if resolved_args is not None and (
                not isinstance(resolved_args, list)
                or not all(isinstance(a, str) for a in resolved_args)
            ):
                self._send_json(400, {"error": "'resolvedArgs' must be an array of strings"})
                return

            if resolved_env is not None and (
                not isinstance(resolved_env, dict)
                or not all(isinstance(k, str) and isinstance(v, str) for k, v in resolved_env.items())
            ):
                self._send_json(400, {"error": "'resolvedEnv' must be an object of string values"})
                return

            tasks, _ = load_host_tasks(workspace)
            task = next((t for t in tasks if t["label"] == label), None)

            if not task:
                available = [t["label"] for t in tasks]
                self._send_json(
                    404,
                    {
                        "error": f"Task '{label}' not found in {workspace}",
                        "available": available,
                    },
                )
                return

            short_ws = os.path.basename(workspace)
            print(f"  Running: [{short_ws}] {label}")
            if resolved_command:
                print("  resolvedCommand provided by extension")
            if resolved_args is not None:
                print(f"  resolvedArgs: {resolved_args}")
            elif input_values:
                print(f"  inputs: {input_values}")
            result = run_task(
                task,
                extra_args,
                workspace,
                input_values,
                resolved_command,
                resolved_args,
                resolved_env,
            )
            status_text = "OK" if result["success"] else "FAILED"
            print(f"  [{status_text}] exit={result['exitCode']}")

            self._send_json(200, result)
            return

        self._send_json(404, {"error": "Not found"})


def main():
    parser = argparse.ArgumentParser(description="Host Task Server (global)")
    parser.add_argument(
        "--port",
        type=int,
        default=DEFAULT_PORT,
        help=f"Port to listen on (default: {DEFAULT_PORT})",
    )
    args = parser.parse_args()

    print("Host Task Server (global)")
    print(f"  Port : {args.port}")
    print()
    print("Workspace is passed per-request — serves all workspaces and worktrees.")
    print(f"Listening on http://0.0.0.0:{args.port}  (Ctrl+C to stop)")
    print(f"From devcontainer: http://host.docker.internal:{args.port}")
    print()

    server = HTTPServer(("0.0.0.0", args.port), TaskHandler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nServer stopped.")
        server.server_close()


if __name__ == "__main__":
    main()
