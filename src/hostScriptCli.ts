#!/usr/bin/env node
import * as http from 'http';

interface TaskOutputStreamEvent {
    type: 'stdout' | 'stderr';
    data: string;
}

interface TaskExitStreamEvent {
    type: 'exit';
    success: boolean;
    exitCode: number;
}

type TaskStreamEvent = TaskOutputStreamEvent | TaskExitStreamEvent;

const ENV_PATTERN = /\$\{env:([^}]+)\}/g;

function detectDefaultHost(): string {
    if (process.env.REMOTE_CONTAINERS === 'true'
        || process.env.CODESPACES === 'true'
        || process.env.REMOTE_CONTAINERS_IPC) {
        return 'host.docker.internal';
    }
    return 'localhost';
}

function getWorkspacePath(): string {
    return process.env.HOST_PROJECT_PATH?.trim() || process.cwd();
}

function shellEscape(value: string): string {
    if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) {
        return value;
    }

    return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function buildCommand(argumentsList: string[]): string {
    if (argumentsList.length === 0) {
        return '';
    }

    if (argumentsList.length === 1) {
        return argumentsList[0];
    }

    return argumentsList.map((part) => shellEscape(part)).join(' ');
}

function expandLocalValues(command: string, workspacePath: string): string {
    const withWorkspace = command.replace(/\$\{workspaceFolder\}/g, workspacePath);
    return withWorkspace.replace(ENV_PATTERN, (match, key: string) => {
        return process.env[key] ?? match;
    });
}

function printUsage(): void {
    process.stderr.write(
        'Usage: host-script <command>\n\n' +
        'Examples:\n' +
        '  host-script "docker-compose up -d"\n' +
        '  host-script "whoami"\n'
    );
}

function httpRequestStream(
    host: string,
    port: number,
    urlPath: string,
    body: string,
    onData: (chunk: string) => void
): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
        const req = http.request({
            method: 'POST',
            hostname: host,
            port,
            path: urlPath,
            timeout: 120_000,
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(body)
            }
        }, (res) => {
            const status = res.statusCode ?? 0;
            let bufferedBody = '';

            res.setEncoding('utf8');
            res.on('data', (chunk: string) => {
                if (status === 200) {
                    onData(chunk);
                    return;
                }
                bufferedBody += chunk;
            });
            res.on('end', () => {
                resolve({ status, body: bufferedBody });
            });
        });

        req.on('error', reject);
        req.on('timeout', () => {
            req.destroy();
            reject(new Error('Request timed out'));
        });
        req.write(body);
        req.end();
    });
}

async function run(): Promise<number> {
    const commandArgs = process.argv.slice(2);
    if (commandArgs.length === 0 || commandArgs[0] === '--help' || commandArgs[0] === '-h') {
        printUsage();
        return commandArgs.length === 0 ? 1 : 0;
    }

    const host = process.env.HOST_SCRIPT_SERVER_HOST?.trim() || detectDefaultHost();
    const port = Number(process.env.HOST_TASK_SERVER_PORT ?? '7890');
    const workspace = getWorkspacePath();
    const command = expandLocalValues(buildCommand(commandArgs), workspace);
    const body = JSON.stringify({
        workspace,
        command,
        cwd: workspace
    });

    let exitCode = 1;
    let sawExit = false;
    let pendingLine = '';

    const processLine = (line: string): void => {
        const trimmed = line.trim();
        if (!trimmed) {
            return;
        }

        const event = JSON.parse(trimmed) as TaskStreamEvent;
        if (event.type === 'stdout') {
            process.stdout.write(event.data);
            return;
        }
        if (event.type === 'stderr') {
            process.stderr.write(event.data);
            return;
        }

        if (event.type === 'exit') {
            exitCode = event.exitCode;
            sawExit = true;
        }
    };

    try {
        const response = await httpRequestStream(host, port, '/exec-stream', body, (chunk) => {
            pendingLine += chunk;
            let newlineIndex = pendingLine.indexOf('\n');
            while (newlineIndex >= 0) {
                const line = pendingLine.slice(0, newlineIndex);
                pendingLine = pendingLine.slice(newlineIndex + 1);
                processLine(line);
                newlineIndex = pendingLine.indexOf('\n');
            }
        });

        if (response.status !== 200) {
            const message = response.body || `Host server returned status ${response.status}`;
            process.stderr.write(`${message.trim()}\n`);
            return 1;
        }

        if (pendingLine.trim()) {
            processLine(pendingLine);
        }

        if (!sawExit) {
            process.stderr.write('Host command stream ended without an exit event.\n');
            return 1;
        }

        return exitCode;
    } catch (error) {
        process.stderr.write(`Cannot reach host server at ${host}:${port}. Is it running? (${String(error)})\n`);
        return 1;
    }
}

void run().then((exitCode) => {
    process.exitCode = exitCode;
});