# Host Task Execution

This workspace runs inside a **devcontainer**. To run commands on the **host machine**, use the host task system.

## How it works

1. A lightweight HTTP server (`host-scripts/server.py`) runs on the host machine
2. It reads `.vscode/tasks.json` and serves tasks whose label starts with `Host:`
3. The VS Code extension bridges the gap — it registers these as `hostScript` type tasks
4. You (the agent) can trigger them using the VS Code `run_task` tool

## Available host tasks

Run the task by its **exact label**:

| Task Label                     | What it does                          |
|-------------------------------|---------------------------------------|
| `Host: Where am I?`          | Show hostname, user, OS on the host   |
| `Host: Docker PS`            | List running Docker containers        |
| `Host: Disk Usage`           | Show disk usage on the host           |
| `Host: Git Status`           | Git status in the workspace           |
| `Host: Listening Ports`      | Show listening network ports          |
| `Host: Docker Compose Logs`  | Tail docker compose logs              |
| `Host: Restart Docker Compose` | Restart docker compose services     |
| `Host: System Info`          | CPU, memory, uptime of host           |

## How to trigger a host task

Use the `run_task` tool with the task label:

```
run_task with id "shell: Host: Where am I?"
```

Or use the VS Code command programmatically:
```
python-copy-qualified-name.hostScripts.runByName  with args: ("Host: Docker PS", [])
```

## Adding new host tasks

Add a new entry to `.vscode/tasks.json` with a label starting with `Host:`:

```jsonc
{
    "label": "Host: My Custom Script",
    "type": "hostScript",
    "command": "/path/to/my/script.sh"
}
```

The host server will pick it up automatically (it re-reads tasks.json on each request).

## Setup

The server starts automatically via `initializeCommand` in `devcontainer.json`:

```jsonc
"initializeCommand": "curl -fsSL https://raw.githubusercontent.com/nidheesh-doctorc/vscode-copy-python-fqn/main/host-scripts/ensure-server.sh | bash"
```

This downloads and runs the bootstrap script on the **host** before the container starts. The server listens on port 7890 by default. The devcontainer reaches it at `host.docker.internal:7890`.
