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
    POST /run-stream {"workspace": "...", "label": "Host: ...", "args": [...]}

Usage:
    python3 host-scripts/server.py [--port 7890]
"""

import argparse
import json
import os
import pwd
import queue
import re
import subprocess
import sys
import threading
import time
from http.server import HTTPServer, BaseHTTPRequestHandler
from pathlib import Path
from urllib.parse import urlparse

DEFAULT_PORT = 7890
TASK_TYPE = "hostScript"
INPUT_PATTERN = re.compile(r"\$\{(?:input|hostInput):([^}]+)\}")
ENV_PATTERN = re.compile(r"\$\{env:([^}]+)\}")
_INTERACTIVE_SHELL_ENV_CACHE: dict[str, str] | None = None
_INTERACTIVE_SHELL_PATH_CACHE: str | None = None


def log_server(message: str) -> None:
    print(message, flush=True)


def log_stream_chunk(prefix: str, chunk: str) -> None:
    if not chunk:
        return

    for line in chunk.splitlines(keepends=True):
        rendered = line.rstrip("\r\n")
        if rendered:
            sys.stdout.write(f"  [{prefix}] {rendered}\n")
        else:
            sys.stdout.write(f"  [{prefix}]\n")
    sys.stdout.flush()


def get_login_shell() -> str:
    global _INTERACTIVE_SHELL_PATH_CACHE

    if _INTERACTIVE_SHELL_PATH_CACHE:
        return _INTERACTIVE_SHELL_PATH_CACHE

    shell = os.environ.get("SHELL", "").strip()
    if not shell:
        try:
            shell = pwd.getpwuid(os.getuid()).pw_shell
        except Exception:
            shell = ""

    if not shell:
        shell = "/bin/bash" if os.path.exists("/bin/bash") else "/bin/sh"

    _INTERACTIVE_SHELL_PATH_CACHE = shell
    return shell


def load_interactive_shell_environment() -> dict[str, str]:
    global _INTERACTIVE_SHELL_ENV_CACHE

    if _INTERACTIVE_SHELL_ENV_CACHE is not None:
        return dict(_INTERACTIVE_SHELL_ENV_CACHE)

    shell = get_login_shell()
    try:
        proc = subprocess.run(
            [shell, "-ilc", "env -0"],
            capture_output=True,
            text=True,
            timeout=10,
            env=os.environ.copy(),
        )
    except Exception as exc:
        log_server(f"[env] Failed to read interactive shell environment from {shell}: {exc}")
        _INTERACTIVE_SHELL_ENV_CACHE = {}
        return {}

    if proc.returncode != 0:
        stderr = proc.stderr.strip()
        log_server(
            f"[env] Interactive shell environment probe failed for {shell} "
            f"with exit={proc.returncode}{': ' + stderr if stderr else ''}"
        )
        _INTERACTIVE_SHELL_ENV_CACHE = {}
        return {}

    parsed: dict[str, str] = {}
    for entry in proc.stdout.split("\0"):
        if not entry or "=" not in entry:
            continue
        key, value = entry.split("=", 1)
        if key:
            parsed[key] = value

    log_server(f"[env] Loaded {len(parsed)} variable(s) from interactive login shell {shell}")
    _INTERACTIVE_SHELL_ENV_CACHE = parsed
    return dict(parsed)


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


def prepare_task_execution(
    task: dict,
    extra_args: list[str],
    workspace: str,
    inputs: dict[str, str] | None = None,
    resolved_command: str | None = None,
    resolved_args: list[str] | None = None,
    resolved_env: dict[str, str] | None = None,
    resolved_cwd: str | None = None,
) -> tuple[bool, list[str] | str, str, dict[str, str]]:
    """Resolve a task into subprocess arguments, cwd, and environment."""
    options = task.get("options", {})
    cwd = resolved_cwd if resolved_cwd is not None else options.get("cwd", workspace)
    env = os.environ.copy()
    interactive_shell_env = load_interactive_shell_environment()
    if interactive_shell_env:
        env.update(interactive_shell_env)
    env_vars = options.get("env", {})
    login_shell = get_login_shell()

    # Host tasks have no stdin bridge from VS Code, so force known prompt-driven
    # tools into non-interactive mode where possible.
    env.setdefault("COREPACK_ENABLE_DOWNLOAD_PROMPT", "0")

    log_server(f"  Raw options.cwd: {options.get('cwd', None)}")
    log_server(f"  Raw options.env: {env_vars}")
    log_server(f"  Login shell: {login_shell}")
    log_server(f"  COREPACK_ENABLE_DOWNLOAD_PROMPT={env.get('COREPACK_ENABLE_DOWNLOAD_PROMPT')}")
    if interactive_shell_env:
        log_server(f"  Interactive shell env merged: {len(interactive_shell_env)} key(s)")
    else:
        log_server("  Interactive shell env merged: unavailable; using server process environment")
    if resolved_cwd is not None:
        log_server(f"  resolvedCwd from extension: {resolved_cwd}")
    if resolved_env is not None:
        log_server(f"  resolvedEnv from extension: {resolved_env}")

    for k, v in env_vars.items():
        env[k] = expand_task_value(str(v), workspace, env, inputs)
    if resolved_env:
        for key, value in resolved_env.items():
            env[key] = str(value)
    for i, arg in enumerate(extra_args, 1):
        env[f"ARG{i}"] = str(arg)

    if resolved_cwd is None:
        cwd = expand_task_value(str(cwd), workspace, env, inputs)
    else:
        cwd = str(resolved_cwd)

    if resolved_command:
        if resolved_args is not None:
            command_spec = [resolved_command, *resolved_args, *extra_args]
            command_spec = [
                expand_task_value(str(part), workspace, env, inputs)
                for part in command_spec
            ]
            log_server("  Using resolved argv from extension")
            log_server(f"  Argv: {command_spec}")
            use_shell = False
        else:
            command_spec = expand_task_value(str(resolved_command), workspace, env, inputs)
            log_server("  Using resolved command from extension")
            use_shell = True
    else:
        command = task.get("command", "")
        task_args = task.get("args", [])

        command = expand_task_value(str(command), workspace, env, inputs)
        task_args = [expand_task_value(str(arg), workspace, env, inputs) for arg in task_args]
        extra_args = [expand_task_value(str(arg), workspace, env, inputs) for arg in extra_args]

        parts = [command] + task_args + extra_args
        command_spec = " ".join(parts)
        use_shell = True

    log_server(f"  Cwd: {cwd}")
    log_server(f"  Env after resolution: { {k: env[k] for k in sorted(env_vars.keys())} }")

    if use_shell:
        command_text = str(command_spec).replace("${workspaceFolder}", workspace)
        command_spec = [login_shell, "-ilc", command_text]
        log_server("  Using interactive login shell command")
        log_server(f"  Argv: {command_spec}")
        use_shell = False

    return use_shell, command_spec, cwd, env


def log_task_output(workspace: str, label: str, stream_name: str, chunk: str) -> None:
    short_ws = os.path.basename(workspace)
    log_stream_chunk(f"task:{short_ws}:{label}:{stream_name}", chunk)


def stream_task(
    task: dict,
    extra_args: list[str],
    workspace: str,
    emit_event,
    inputs: dict[str, str] | None = None,
    resolved_command: str | None = None,
    resolved_args: list[str] | None = None,
    resolved_env: dict[str, str] | None = None,
    resolved_cwd: str | None = None,
) -> dict:
    """Execute a task and emit output events as data arrives."""
    use_shell, command_spec, cwd, env = prepare_task_execution(
        task,
        extra_args,
        workspace,
        inputs,
        resolved_command,
        resolved_args,
        resolved_env,
        resolved_cwd,
    )
    timeout = 1200
    event_queue: queue.Queue[dict] = queue.Queue()
    proc = None

    def read_stream(stream_name: str, stream) -> None:
        try:
            for chunk in iter(stream.readline, ""):
                if chunk:
                    log_task_output(workspace, task.get("label", ""), stream_name, chunk)
                    event_queue.put({"type": stream_name, "data": chunk})
        finally:
            if stream is not None:
                stream.close()
            event_queue.put({"type": "stream-closed", "stream": stream_name})

    try:
        proc = subprocess.Popen(
            command_spec,
            shell=use_shell,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1,
            cwd=cwd,
            env=env,
        )

        stdout_thread = threading.Thread(
            target=read_stream,
            args=("stdout", proc.stdout),
            daemon=True,
        )
        stderr_thread = threading.Thread(
            target=read_stream,
            args=("stderr", proc.stderr),
            daemon=True,
        )
        stdout_thread.start()
        stderr_thread.start()

        deadline = time.monotonic() + timeout
        open_streams = 2
        while open_streams > 0:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise subprocess.TimeoutExpired(command_spec, timeout)
            try:
                event = event_queue.get(timeout=min(0.1, remaining))
            except queue.Empty:
                continue

            if event["type"] == "stream-closed":
                open_streams -= 1
                continue

            emit_event(event)

        exit_code = proc.wait(timeout=max(0.1, deadline - time.monotonic()))
        result = {
            "success": exit_code == 0,
            "exitCode": exit_code,
            "output": "",
            "error": "",
        }
        emit_event(
            {
                "type": "exit",
                "success": result["success"],
                "exitCode": result["exitCode"],
            }
        )
        return result
    except subprocess.TimeoutExpired:
        if proc is not None and proc.poll() is None:
            proc.kill()
            proc.wait()
        timeout_message = f"Task timed out after {timeout}s"
        emit_event({"type": "stderr", "data": f"{timeout_message}\n"})
        emit_event({"type": "exit", "success": False, "exitCode": -1})
        return {
            "success": False,
            "exitCode": -1,
            "output": "",
            "error": timeout_message,
        }
    except Exception as e:
        if proc is not None and proc.poll() is None:
            proc.kill()
            proc.wait()
        error_message = str(e)
        emit_event({"type": "stderr", "data": f"{error_message}\n"})
        emit_event({"type": "exit", "success": False, "exitCode": -1})
        return {
            "success": False,
            "exitCode": -1,
            "output": "",
            "error": error_message,
        }


def run_task(
    task: dict,
    extra_args: list[str],
    workspace: str,
    inputs: dict[str, str] | None = None,
    resolved_command: str | None = None,
    resolved_args: list[str] | None = None,
    resolved_env: dict[str, str] | None = None,
    resolved_cwd: str | None = None,
) -> dict:
    """Execute a task's shell command on the host and return the result."""
    use_shell, command_spec, cwd, env = prepare_task_execution(
        task,
        extra_args,
        workspace,
        inputs,
        resolved_command,
        resolved_args,
        resolved_env,
        resolved_cwd,
    )
    timeout = 1200

    try:
        proc = subprocess.run(
            command_spec,
            shell=use_shell,
            stdin=subprocess.DEVNULL,
            capture_output=True,
            text=True,
            timeout=timeout,
            cwd=cwd,
            env=env,
        )
        log_task_output(workspace, task.get("label", ""), "stdout", proc.stdout)
        log_task_output(workspace, task.get("label", ""), "stderr", proc.stderr)
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
    protocol_version = "HTTP/1.1"

    def log_message(self, format, *args):
        timestamp = time.strftime("%H:%M:%S")
        log_server(f"  [{timestamp}] {format % args}")

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

    def _parse_run_request(self, request: dict) -> dict | None:
        workspace = self._get_workspace(request)
        if workspace is None:
            return None

        label = request.get("label", "")
        extra_args = request.get("args", [])
        input_values = request.get("inputs", {})
        resolved_command = request.get("resolvedCommand", None)
        resolved_args = request.get("resolvedArgs", None)
        resolved_env = request.get("resolvedEnv", None)
        resolved_cwd = request.get("resolvedCwd", None)

        if not label:
            self._send_json(400, {"error": "'label' is required"})
            return None

        if not isinstance(extra_args, list) or not all(isinstance(a, str) for a in extra_args):
            self._send_json(400, {"error": "'args' must be an array of strings"})
            return None

        if not isinstance(input_values, dict):
            self._send_json(400, {"error": "'inputs' must be an object"})
            return None

        if resolved_args is not None and (
            not isinstance(resolved_args, list)
            or not all(isinstance(a, str) for a in resolved_args)
        ):
            self._send_json(400, {"error": "'resolvedArgs' must be an array of strings"})
            return None

        if resolved_env is not None and (
            not isinstance(resolved_env, dict)
            or not all(isinstance(k, str) and isinstance(v, str) for k, v in resolved_env.items())
        ):
            self._send_json(400, {"error": "'resolvedEnv' must be an object of string values"})
            return None

        if resolved_cwd is not None and not isinstance(resolved_cwd, str):
            self._send_json(400, {"error": "'resolvedCwd' must be a string"})
            return None

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
            return None

        return {
            "workspace": workspace,
            "label": label,
            "extra_args": extra_args,
            "input_values": input_values,
            "resolved_command": resolved_command,
            "resolved_args": resolved_args,
            "resolved_env": resolved_env,
            "resolved_cwd": resolved_cwd,
            "task": task,
        }

    def _log_run_request(self, run_request: dict) -> None:
        short_ws = os.path.basename(run_request["workspace"])
        log_server(f"  Running: [{short_ws}] {run_request['label']}")
        if run_request["resolved_command"]:
            log_server("  resolvedCommand provided by extension")
        if run_request["resolved_args"] is not None:
            log_server(f"  resolvedArgs: {run_request['resolved_args']}")
        if run_request["resolved_cwd"] is not None:
            log_server(f"  resolvedCwd: {run_request['resolved_cwd']}")
        if run_request["resolved_env"] is not None:
            log_server(f"  resolvedEnv keys: {sorted(run_request['resolved_env'].keys())}")
        elif run_request["input_values"]:
            log_server(f"  inputs: {run_request['input_values']}")

    def _send_stream_event(self, event: dict) -> None:
        payload = json.dumps(event).encode("utf-8") + b"\n"
        self.wfile.write(payload)
        self.wfile.flush()

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
            run_request = self._parse_run_request(request)
            if run_request is None:
                return

            self._log_run_request(run_request)
            result = run_task(
                run_request["task"],
                run_request["extra_args"],
                run_request["workspace"],
                run_request["input_values"],
                run_request["resolved_command"],
                run_request["resolved_args"],
                run_request["resolved_env"],
                run_request["resolved_cwd"],
            )
            status_text = "OK" if result["success"] else "FAILED"
            print(f"  [{status_text}] exit={result['exitCode']}")

            self._send_json(200, result)
            return

        if parsed.path == "/run-stream":
            request = self._read_json_body()
            if request is None:
                return
            run_request = self._parse_run_request(request)
            if run_request is None:
                return

            self._log_run_request(run_request)
            self.send_response(200)
            self.send_header("Content-Type", "application/x-ndjson")
            self.send_header("Cache-Control", "no-cache")
            self.send_header("Connection", "close")
            self.end_headers()

            result = stream_task(
                run_request["task"],
                run_request["extra_args"],
                run_request["workspace"],
                self._send_stream_event,
                run_request["input_values"],
                run_request["resolved_command"],
                run_request["resolved_args"],
                run_request["resolved_env"],
                run_request["resolved_cwd"],
            )
            status_text = "OK" if result["success"] else "FAILED"
            print(f"  [{status_text}] exit={result['exitCode']}")
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
