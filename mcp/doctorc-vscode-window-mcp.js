#!/usr/bin/env node

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const serverInfo = {
    name: 'doctorc-vscode-mcp',
    version: '0.1.0',
};

let inputBuffer = Buffer.alloc(0);
let transportMode;

function registryDir() {
    return process.env.DOCTORC_VSCODE_MCP_REGISTRY_DIR || path.join(os.tmpdir(), 'doctorc-vscode-mcp');
}

function registryPathForWorkspace(workspacePath) {
    const hash = crypto.createHash('sha256').update(workspacePath).digest('hex').slice(0, 24);
    return path.join(registryDir(), `${hash}.json`);
}

function safeJsonParse(value, fallback) {
    if (!value) {
        return fallback;
    }
    try {
        return JSON.parse(value);
    } catch {
        return fallback;
    }
}

function workspaceCandidates() {
    const explicit = [
        process.env.DOCTORC_VSCODE_WORKSPACE,
        process.env.WORKSPACE_FOLDER,
        process.env.PWD,
        process.cwd(),
    ].filter(Boolean);

    const fromEnv = safeJsonParse(process.env.DOCTORC_VSCODE_WORKSPACE_FOLDERS, []);
    return [...fromEnv, ...explicit].map((candidate) => path.resolve(candidate));
}

function pathContains(parent, child) {
    const relative = path.relative(parent, child);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function readJsonFile(filePath) {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function findRegistry() {
    const candidates = workspaceCandidates();
    for (const workspacePath of candidates) {
        const filePath = registryPathForWorkspace(workspacePath);
        if (fs.existsSync(filePath)) {
            return { filePath, registry: readJsonFile(filePath), workspacePath };
        }
    }

    if (!fs.existsSync(registryDir())) {
        throw new Error(`VS Code bridge registry directory does not exist: ${registryDir()}`);
    }

    const cwd = path.resolve(process.cwd());
    const matches = fs.readdirSync(registryDir())
        .filter((name) => name.endsWith('.json'))
        .map((name) => {
            const filePath = path.join(registryDir(), name);
            const registry = readJsonFile(filePath);
            return { filePath, registry };
        })
        .filter(({ registry }) => Array.isArray(registry.workspaceFolders))
        .filter(({ registry }) => registry.workspaceFolders.some((folder) => pathContains(path.resolve(folder), cwd)))
        .sort((left, right) => String(right.registry.updatedAt || '').localeCompare(String(left.registry.updatedAt || '')));

    if (matches.length > 0) {
        return { ...matches[0], workspacePath: cwd };
    }

    throw new Error(`No VS Code bridge registry matched workspace: ${cwd}`);
}

function bridgeRequest(method, route, body) {
    const { registry, filePath } = findRegistry();
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body), 'utf8');

    return new Promise((resolve, reject) => {
        const req = http.request({
            host: '127.0.0.1',
            port: registry.port,
            path: route,
            method,
            headers: {
                ...(payload ? {
                    'Content-Type': 'application/json',
                    'Content-Length': payload.length,
                } : {}),
            },
            timeout: 120000,
        }, (res) => {
            const chunks = [];
            res.on('data', (chunk) => chunks.push(chunk));
            res.on('end', () => {
                const text = Buffer.concat(chunks).toString('utf8');
                const parsed = safeJsonParse(text, { raw: text });
                if ((res.statusCode || 0) >= 400) {
                    reject(new Error(`Bridge request failed via ${filePath}: ${res.statusCode} ${text}`));
                    return;
                }
                resolve(parsed);
            });
        });

        req.on('timeout', () => {
            req.destroy(new Error(`Bridge request timed out: ${method} ${route}`));
        });
        req.on('error', reject);
        if (payload) {
            req.write(payload);
        }
        req.end();
    });
}

function send(message) {
    const body = Buffer.from(JSON.stringify(message), 'utf8');
    if (transportMode === 'line') {
        process.stdout.write(`${body.toString('utf8')}\n`);
        return;
    }

    const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii');
    process.stdout.write(Buffer.concat([header, body]));
}

function result(id, value) {
    send({ jsonrpc: '2.0', id, result: value });
}

function error(id, code, message) {
    send({ jsonrpc: '2.0', id, error: { code, message } });
}

function toolResult(payload) {
    return {
        content: [
            {
                type: 'text',
                text: JSON.stringify(payload, null, 2),
            },
        ],
    };
}

function listTools() {
    return {
        tools: [
            {
                name: 'doctorc_vscode_bridge_status',
                description: 'Return status for the current workspace VS Code API bridge.',
                inputSchema: { type: 'object', properties: {} },
            },
            {
                name: 'doctorc_vscode_list_tasks',
                description: 'List VS Code tasks visible to the current workspace window.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        type: { type: 'string', description: 'Optional VS Code task type filter, such as shell or hostScript.' },
                    },
                },
            },
            {
                name: 'doctorc_vscode_run_task',
                description: 'Run a VS Code task by label through vscode.tasks.executeTask.',
                inputSchema: {
                    type: 'object',
                    required: ['label'],
                    properties: {
                        label: { type: 'string', description: 'Exact VS Code task label/name.' },
                        type: { type: 'string', description: 'Optional VS Code task type filter.' },
                        workspaceFolder: { type: 'string', description: 'Optional absolute workspace folder path.' },
                    },
                },
            },
            {
                name: 'doctorc_vscode_list_debug_configs',
                description: 'List launch.json debug configurations visible to the current workspace window.',
                inputSchema: { type: 'object', properties: {} },
            },
            {
                name: 'doctorc_vscode_start_debugging',
                description: 'Start a VS Code launch.json debug configuration by name.',
                inputSchema: {
                    type: 'object',
                    required: ['name'],
                    properties: {
                        name: { type: 'string', description: 'Exact launch configuration name.' },
                        workspaceFolder: { type: 'string', description: 'Optional absolute workspace folder path.' },
                        noDebug: { type: 'boolean', description: 'Run without debugging when true.' },
                    },
                },
            },
        ],
    };
}

async function callTool(name, args) {
    if (name === 'doctorc_vscode_bridge_status') {
        return toolResult(await bridgeRequest('GET', '/status'));
    }
    if (name === 'doctorc_vscode_list_tasks') {
        const query = args && args.type ? `?type=${encodeURIComponent(args.type)}` : '';
        return toolResult(await bridgeRequest('GET', `/tasks${query}`));
    }
    if (name === 'doctorc_vscode_run_task') {
        return toolResult(await bridgeRequest('POST', '/tasks/run', args || {}));
    }
    if (name === 'doctorc_vscode_list_debug_configs') {
        return toolResult(await bridgeRequest('GET', '/debug/configurations'));
    }
    if (name === 'doctorc_vscode_start_debugging') {
        return toolResult(await bridgeRequest('POST', '/debug/start', args || {}));
    }

    throw new Error(`Unknown tool: ${name}`);
}

async function handle(message) {
    if (!message || message.jsonrpc !== '2.0') {
        return;
    }

    if (message.method === 'notifications/initialized') {
        return;
    }

    if (message.id === undefined || message.id === null) {
        return;
    }

    try {
        switch (message.method) {
            case 'initialize':
                result(message.id, {
                    protocolVersion: message.params && message.params.protocolVersion || '2024-11-05',
                    capabilities: { tools: {} },
                    serverInfo,
                });
                return;
            case 'tools/list':
                result(message.id, listTools());
                return;
            case 'tools/call':
                result(message.id, await callTool(message.params && message.params.name, message.params && message.params.arguments || {}));
                return;
            default:
                error(message.id, -32601, `Method not found: ${message.method}`);
        }
    } catch (err) {
        error(message.id, -32000, err && err.message ? err.message : String(err));
    }
}

function parseContentLengthMessage() {
    const headerEnd = inputBuffer.indexOf('\r\n\r\n');
    if (headerEnd === -1) {
        return undefined;
    }

    const header = inputBuffer.subarray(0, headerEnd).toString('ascii');
    const contentLengthMatch = /^Content-Length:\s*(\d+)$/im.exec(header);
    if (!contentLengthMatch) {
        throw new Error('Missing Content-Length header');
    }

    const contentLength = Number(contentLengthMatch[1]);
    const bodyStart = headerEnd + 4;
    const bodyEnd = bodyStart + contentLength;
    if (inputBuffer.length < bodyEnd) {
        return undefined;
    }

    const body = inputBuffer.subarray(bodyStart, bodyEnd).toString('utf8');
    inputBuffer = inputBuffer.subarray(bodyEnd);
    return JSON.parse(body);
}

function parseLineMessage() {
    const newlineIndex = inputBuffer.indexOf('\n');
    if (newlineIndex === -1) {
        return undefined;
    }

    const line = inputBuffer.subarray(0, newlineIndex).toString('utf8').trim();
    inputBuffer = inputBuffer.subarray(newlineIndex + 1);
    if (!line) {
        return parseNextMessage();
    }

    return JSON.parse(line);
}

function parseNextMessage() {
    if (transportMode === 'content-length') {
        return parseContentLengthMessage();
    }

    if (transportMode === 'line') {
        return parseLineMessage();
    }

    const trimmedStart = inputBuffer.toString('utf8', 0, Math.min(inputBuffer.length, 32)).trimStart();
    if (trimmedStart.startsWith('Content-Length:')) {
        transportMode = 'content-length';
        return parseContentLengthMessage();
    }

    if (trimmedStart.startsWith('{')) {
        transportMode = 'line';
        return parseLineMessage();
    }

    return undefined;
}

function processBuffer() {
    while (true) {
        const message = parseNextMessage();
        if (!message) {
            return;
        }
        void handle(message);
    }
}

process.stdin.on('data', (chunk) => {
    inputBuffer = Buffer.concat([inputBuffer, chunk]);
    try {
        processBuffer();
    } catch (err) {
        process.stderr.write(`MCP framing error: ${err && err.message ? err.message : String(err)}\n`);
        process.exitCode = 1;
    }
});

process.stderr.write('DoctorC VS Code MCP proxy started\n');
