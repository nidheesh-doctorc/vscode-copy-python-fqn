import * as vscode from 'vscode';
import * as http from 'http';
import * as fs from 'fs';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface HostTask {
    label: string;
    command: string;
    args: string[];
    options?: HostTaskOptions;
}

interface HostTaskOptions {
    cwd?: string;
    env?: Record<string, string>;
}

interface InputDefinition {
    id: string;
    type: string;
    description?: string;
    default?: string;
    options?: string[];
}

interface TaskRunResult {
    success: boolean;
    exitCode: number;
    output: string;
    error: string;
}

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

interface ResolvedTaskOptions {
    cwd?: string;
    env?: Record<string, string>;
}

interface HostScriptTaskDefinition extends vscode.TaskDefinition {
    command: string;
    args?: string[];
    options?: HostTaskOptions;
}

type ResolutionLogger = (message: string) => void;

// ---------------------------------------------------------------------------
// HTTP helper — uses Node built-in http, no extra dependencies
// ---------------------------------------------------------------------------

function httpRequest(
    method: 'GET' | 'POST',
    host: string,
    port: number,
    urlPath: string,
    body?: string
): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
        const req = http.request({ method, hostname: host, port, path: urlPath, timeout: 120_000 }, (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (chunk: Buffer) => chunks.push(chunk));
            res.on('end', () => {
                resolve({
                    status: res.statusCode ?? 0,
                    body: Buffer.concat(chunks).toString('utf8')
                });
            });
        });
        req.on('error', reject);
        req.on('timeout', () => {
            req.destroy();
            reject(new Error('Request timed out'));
        });
        if (body) {
            req.setHeader('Content-Type', 'application/json');
            req.setHeader('Content-Length', Buffer.byteLength(body));
            req.write(body);
        }
        req.end();
    });
}

function httpRequestStream(
    method: 'GET' | 'POST',
    host: string,
    port: number,
    urlPath: string,
    onData: (chunk: string) => void,
    body?: string
): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
        const req = http.request({ method, hostname: host, port, path: urlPath, timeout: 120_000 }, (res) => {
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

        if (body) {
            req.setHeader('Content-Type', 'application/json');
            req.setHeader('Content-Length', Buffer.byteLength(body));
            req.write(body);
        }

        req.end();
    });
}

// ---------------------------------------------------------------------------
// HostScriptRunner — HTTP client talking to the host task server
// ---------------------------------------------------------------------------

function detectDefaultHost(): string {
    // Inside a devcontainer, use host.docker.internal to reach the host.
    // On the host itself, use localhost.
    if (process.env.REMOTE_CONTAINERS === 'true'
        || process.env.CODESPACES === 'true'
        || process.env.REMOTE_CONTAINERS_IPC
        || vscode.env.remoteName === 'dev-container'
        || vscode.env.remoteName === 'attached-container') {
        return 'host.docker.internal';
    }
    return 'localhost';
}

export class HostScriptRunner implements vscode.Disposable {
    private host: string;
    private port: number;
    private outputChannel: vscode.OutputChannel;

    constructor() {
        const config = vscode.workspace.getConfiguration('pythonCopyQualifiedName.hostScripts');
        const defaultHost = detectDefaultHost();
        this.host = config.get<string>('host', '') || defaultHost;
        this.port = config.get<number>('port', 7890);
        this.outputChannel = vscode.window.createOutputChannel('Host Scripts');
        this.logDebug(
            `Initialized host script runner with host=${this.host}, port=${this.port}, defaultHost=${defaultHost}`
        );
    }

    private get baseUrl(): string {
        return `${this.host}:${this.port}`;
    }

    /** Resolve the host-side workspace path for the current VS Code workspace. */
    private getWorkspacePath(): string | undefined {
        const folders = vscode.workspace.workspaceFolders;
        if (!folders || folders.length === 0) {
            this.logDebug('Workspace path resolution failed: no workspace folders are open.');
            return undefined;
        }
        // 1. Explicit override in settings
        const config = vscode.workspace.getConfiguration('pythonCopyQualifiedName.hostScripts');
        const override = config.get<string>('hostWorkspacePath', '');
        if (override) {
            this.logDebug(`Workspace path resolved from settings override: ${override}`);
            return override;
        }
        // 2. HOST_PROJECT_PATH is set via remoteEnv in devcontainer.json
        //    to pass the host-side workspace path into the container.
        const hostPath = process.env.HOST_PROJECT_PATH;
        if (hostPath) {
            this.logDebug(`Workspace path resolved from process.env.HOST_PROJECT_PATH: ${hostPath}`);
            return hostPath;
        }
        // 3. Fallback: use fsPath directly (correct when running on the host)
        const containerPath = folders[0].uri.fsPath;
        this.logDebug(`Workspace path falling back to first workspace folder fsPath: ${containerPath}`);
        if (containerPath.startsWith('/workspaces/')) {
            this.logDebug(
                `Warning: workspace path "${containerPath}" looks like a container path. ` +
                `Add to devcontainer.json remoteEnv: { "HOST_PROJECT_PATH": "\${localWorkspaceFolder}" }`
            );
        }
        return containerPath;
    }

    /** List tasks the host server exposes for the current workspace. */
    public async listTasks(): Promise<{ tasks: HostTask[]; inputs: InputDefinition[] }> {
        const workspace = this.getWorkspacePath();
        if (!workspace) {
            this.logDebug('Skipping task list request because workspace path could not be resolved.');
            return { tasks: [], inputs: [] };
        }
        try {
            const body = JSON.stringify({ workspace });
            this.logDebug(`[listTasks] Requesting tasks for workspace=${workspace}`);
            const res = await httpRequest('POST', this.host, this.port, '/tasks', body);
            if (res.status !== 200) {
                this.logDebug(`[listTasks] Non-200 response status=${res.status} body=${res.body}`);
                return { tasks: [], inputs: [] };
            }
            const data = JSON.parse(res.body) as { tasks: HostTask[]; inputs: InputDefinition[] };
            this.logDebug(
                `[listTasks] Received ${(data.tasks ?? []).length} task(s) and ${(data.inputs ?? []).length} input definition(s)`
            );
            return { tasks: data.tasks ?? [], inputs: data.inputs ?? [] };
        } catch (err) {
            this.logDebug(`[listTasks] Request failed: ${String(err)}`);
            return { tasks: [], inputs: [] };
        }
    }

    /** Run a host task by its label. */
    public async runTask(
        label: string,
        args: string[] = [],
        inputs?: Record<string, string>,
        resolvedCommand?: string,
        resolvedArgs?: string[],
        resolvedEnv?: Record<string, string>,
        resolvedCwd?: string
    ): Promise<TaskRunResult> {
        const workspace = this.getWorkspacePath();
        if (!workspace) {
            this.logDebug(`[runTask] Cannot run '${label}' because no workspace folder is open.`);
            return {
                success: false,
                exitCode: -1,
                output: '',
                error: 'No workspace folder open'
            };
        }
        try {
            const payload: Record<string, unknown> = { workspace, label, args, inputs: inputs ?? {} };
            if (resolvedCommand) {
                payload.resolvedCommand = resolvedCommand;
            }
            if (resolvedArgs) {
                payload.resolvedArgs = resolvedArgs;
            }
            if (resolvedEnv) {
                payload.resolvedEnv = resolvedEnv;
            }
            if (resolvedCwd) {
                payload.resolvedCwd = resolvedCwd;
            }
            const body = JSON.stringify(payload);
            this.logDebug(`[runTask] label=${label} workspace=${workspace}`);
            if (resolvedCommand) {
                this.logDebug(`[runTask] resolvedCommand=${resolvedCommand}`);
            }
            if (resolvedArgs) {
                this.logDebug(`[runTask] resolvedArgs=${JSON.stringify(resolvedArgs)}`);
            }
            if (resolvedEnv) {
                this.logDebug(`[runTask] resolvedEnv=${JSON.stringify(resolvedEnv)}`);
            }
            if (resolvedCwd) {
                this.logDebug(`[runTask] resolvedCwd=${resolvedCwd}`);
            }
            if (inputs && Object.keys(inputs).length > 0) {
                this.logDebug(`[runTask] inputs=${JSON.stringify(inputs)}`);
            }
            this.logDebug(`[runTask] payload=${body}`);
            const res = await httpRequest('POST', this.host, this.port, '/run', body);
            this.logDebug(`[runTask] response status=${res.status}`);
            this.logDebug(`[runTask] response body=${res.body}`);
            if (res.status === 404) {
                const data = JSON.parse(res.body);
                return {
                    success: false,
                    exitCode: -1,
                    output: '',
                    error: data.error ?? `Task '${label}' not found on host`
                };
            }
            return JSON.parse(res.body) as TaskRunResult;
        } catch (err) {
            this.logDebug(`[runTask] Request failed: ${String(err)}`);
            return {
                success: false,
                exitCode: -1,
                output: '',
                error: `Cannot reach host server at ${this.baseUrl}. Is it running? (${err})`
            };
        }
    }

    public async runTaskStreaming(
        label: string,
        onEvent: (event: TaskStreamEvent) => void,
        args: string[] = [],
        inputs?: Record<string, string>,
        resolvedCommand?: string,
        resolvedArgs?: string[],
        resolvedEnv?: Record<string, string>,
        resolvedCwd?: string
    ): Promise<TaskRunResult> {
        const workspace = this.getWorkspacePath();
        if (!workspace) {
            this.logDebug(`[runTaskStreaming] Cannot run '${label}' because no workspace folder is open.`);
            return {
                success: false,
                exitCode: -1,
                output: '',
                error: 'No workspace folder open'
            };
        }

        const result: TaskRunResult = {
            success: false,
            exitCode: -1,
            output: '',
            error: ''
        };

        try {
            const payload: Record<string, unknown> = { workspace, label, args, inputs: inputs ?? {} };
            if (resolvedCommand) {
                payload.resolvedCommand = resolvedCommand;
            }
            if (resolvedArgs) {
                payload.resolvedArgs = resolvedArgs;
            }
            if (resolvedEnv) {
                payload.resolvedEnv = resolvedEnv;
            }
            if (resolvedCwd) {
                payload.resolvedCwd = resolvedCwd;
            }

            const body = JSON.stringify(payload);
            let pendingLine = '';

            this.logDebug(`[runTaskStreaming] label=${label} workspace=${workspace}`);
            this.logDebug(`[runTaskStreaming] payload=${body}`);

            const processLine = (line: string): void => {
                const trimmed = line.trim();
                if (!trimmed) {
                    return;
                }

                const event = JSON.parse(trimmed) as TaskStreamEvent;
                this.logDebug(`[runTaskStreaming] event=${trimmed}`);
                if (event.type === 'stdout') {
                    result.output += event.data;
                } else if (event.type === 'stderr') {
                    result.error += event.data;
                } else if (event.type === 'exit') {
                    result.success = event.success;
                    result.exitCode = event.exitCode;
                }
                onEvent(event);
            };

            const res = await httpRequestStream(
                'POST',
                this.host,
                this.port,
                '/run-stream',
                (chunk) => {
                    pendingLine += chunk;
                    let newlineIndex = pendingLine.indexOf('\n');
                    while (newlineIndex >= 0) {
                        const line = pendingLine.slice(0, newlineIndex);
                        pendingLine = pendingLine.slice(newlineIndex + 1);
                        processLine(line);
                        newlineIndex = pendingLine.indexOf('\n');
                    }
                },
                body
            );

            this.logDebug(`[runTaskStreaming] response status=${res.status}`);
            if (res.status !== 200) {
                this.logDebug(`[runTaskStreaming] response body=${res.body}`);
                if (res.status === 404) {
                    const data = JSON.parse(res.body) as { error?: string };
                    return {
                        success: false,
                        exitCode: -1,
                        output: '',
                        error: data.error ?? `Task '${label}' not found on host`
                    };
                }
                return {
                    success: false,
                    exitCode: -1,
                    output: '',
                    error: `Host server returned status ${res.status}`
                };
            }

            if (pendingLine.trim()) {
                processLine(pendingLine);
            }

            if (result.exitCode === -1 && !result.success) {
                result.error = result.error || 'Host task stream ended without an exit event';
            }

            return result;
        } catch (err) {
            this.logDebug(`[runTaskStreaming] Request failed: ${String(err)}`);
            return {
                success: false,
                exitCode: -1,
                output: '',
                error: `Cannot reach host server at ${this.baseUrl}. Is it running? (${err})`
            };
        }
    }

    /** Check whether the host task server is alive. */
    public async isServerRunning(): Promise<boolean> {
        try {
            this.logDebug(`[health] Checking host task server at ${this.baseUrl}`);
            const res = await httpRequest('GET', this.host, this.port, '/health');
            this.logDebug(`[health] Response status=${res.status} body=${res.body}`);
            return res.status === 200;
        } catch (err) {
            this.logDebug(`[health] Health check failed: ${String(err)}`);
            return false;
        }
    }

    /** Re-read settings after a configuration change. */
    public updateConfiguration(): void {
        const config = vscode.workspace.getConfiguration('pythonCopyQualifiedName.hostScripts');
        const defaultHost = detectDefaultHost();
        this.host = config.get<string>('host', '') || defaultHost;
        this.port = config.get<number>('port', 7890);
        this.logDebug(
            `Updated host script runner configuration to host=${this.host}, port=${this.port}, defaultHost=${defaultHost}`
        );
    }

    public resolveTaskEnv(
        task: HostTask,
        inputs?: Record<string, string>,
        logger?: ResolutionLogger
    ): Record<string, string> | undefined {
        const env = task.options?.env;
        if (!env || Object.keys(env).length === 0) {
            const message = `[resolveTaskEnv] Task '${task.label}' has no environment overrides.`;
            this.logDebug(message);
            logger?.(message);
            return undefined;
        }

        const workspace = this.getWorkspacePath();
        const resolvedEnv: Record<string, string> = {};
        const activeLogger = this.createCombinedLogger(logger);
        activeLogger(
            `[resolveTaskEnv] Resolving ${Object.keys(env).length} env key(s) for task '${task.label}' with workspace=${workspace ?? '<undefined>'}`
        );
        for (const [key, value] of Object.entries(env)) {
            activeLogger(`[resolveTaskEnv] Resolving env key ${key} from template ${JSON.stringify(value)}`);
            resolvedEnv[key] = resolveTaskValue(value, workspace, inputs, activeLogger, `env:${key}`);
            activeLogger(`[resolveTaskEnv] Resolved env key ${key}=${JSON.stringify(resolvedEnv[key])}`);
        }
        return resolvedEnv;
    }

    public resolveTaskOptions(
        task: HostTask,
        inputs?: Record<string, string>,
        logger?: ResolutionLogger
    ): ResolvedTaskOptions | undefined {
        const activeLogger = this.createCombinedLogger(logger);
        const cwdTemplate = task.options?.cwd;
        const env = this.resolveTaskEnv(task, inputs, activeLogger);
        let cwd: string | undefined;

        if (cwdTemplate) {
            activeLogger(`[resolveTaskOptions] Resolving cwd from template ${JSON.stringify(cwdTemplate)}`);
            const workspace = this.getWorkspacePath();
            cwd = resolveTaskValue(cwdTemplate, workspace, inputs, activeLogger, 'cwd');
            activeLogger(`[resolveTaskOptions] Resolved cwd=${JSON.stringify(cwd)}`);
        } else {
            activeLogger(`[resolveTaskOptions] Task '${task.label}' has no cwd override.`);
        }

        if (!cwd && !env) {
            return undefined;
        }

        return { cwd, env };
    }

    public logDebug(message: string): void {
        const timestamp = new Date().toISOString();
        this.outputChannel.appendLine(`[${timestamp}] ${message}`);
    }

    public createCombinedLogger(logger?: ResolutionLogger): ResolutionLogger {
        return (message: string) => {
            this.logDebug(message);
            logger?.(message);
        };
    }

    /** Show output in the dedicated output channel. */
    public showOutput(heading: string, result: TaskRunResult): void {
        this.outputChannel.appendLine('');
        this.outputChannel.appendLine(`=== ${heading} ===`);
        this.outputChannel.appendLine(`Exit code: ${result.exitCode}`);
        this.outputChannel.appendLine('---');
        if (result.output) {
            this.outputChannel.appendLine(result.output);
        }
        if (result.error) {
            this.outputChannel.appendLine('--- Error ---');
            this.outputChannel.appendLine(result.error);
        }
        this.outputChannel.show(true);
    }

    public dispose(): void {
        this.outputChannel.dispose();
    }
}

// ---------------------------------------------------------------------------
// Input and env variable resolution
// ---------------------------------------------------------------------------

const INPUT_PATTERN = /\$\{(?:input|hostInput):([^}]+)\}/g;
const VSCODE_INPUT_PATTERN = /\$\{input:([^}]+)\}/g;
const ENV_PATTERN = /\$\{env:([^}]+)\}/g;
let initProcessEnvCache: Record<string, string> | null | undefined;

/** Extract unique input variable names from a task's command + args. */
function extractInputVariables(task: HostTask): string[] {
    const text = [task.command, ...task.args].join(' ');
    const names = new Set<string>();
    let match: RegExpExecArray | null;
    INPUT_PATTERN.lastIndex = 0;
    while ((match = INPUT_PATTERN.exec(text)) !== null) {
        names.add(match[1]);
    }
    return [...names];
}

function hasVsCodeInputVariables(task: HostTask): boolean {
    const text = [task.command, ...task.args].join(' ');
    VSCODE_INPUT_PATTERN.lastIndex = 0;
    return VSCODE_INPUT_PATTERN.test(text);
}

function replaceInputPatterns(value: string, key: string, resolved: string): string {
    return value
        .split(`\${input:${key}}`)
        .join(resolved)
        .split(`\${hostInput:${key}}`)
        .join(resolved);
}

function formatResolutionContext(context?: string): string {
    return context ? ` (${context})` : '';
}

function maskEnvironmentValue(value: string): string {
    if (value.length <= 120) {
        return value;
    }
    return `${value.slice(0, 117)}...`;
}

function readInitProcessEnvironment(logger?: ResolutionLogger): Record<string, string> | null {
    if (initProcessEnvCache !== undefined) {
        logger?.(
            `[env] Reusing cached /proc/1/environ result: ${initProcessEnvCache ? `${Object.keys(initProcessEnvCache).length} key(s)` : 'unavailable'}`
        );
        return initProcessEnvCache;
    }

    try {
        logger?.('[env] Reading /proc/1/environ for fallback environment resolution.');
        const raw = fs.readFileSync('/proc/1/environ', 'utf8');
        const parsed: Record<string, string> = {};
        for (const entry of raw.split('\0')) {
            if (!entry) {
                continue;
            }
            const separatorIndex = entry.indexOf('=');
            if (separatorIndex <= 0) {
                continue;
            }
            const key = entry.slice(0, separatorIndex);
            const value = entry.slice(separatorIndex + 1);
            parsed[key] = value;
        }
        initProcessEnvCache = parsed;
        logger?.(`[env] Loaded ${Object.keys(parsed).length} key(s) from /proc/1/environ.`);
    } catch (err) {
        initProcessEnvCache = null;
        logger?.(`[env] Failed to read /proc/1/environ: ${String(err)}`);
    }

    return initProcessEnvCache;
}

function getEnvironmentVariable(name: string, logger?: ResolutionLogger): string | undefined {
    const currentValue = process.env[name];
    if (currentValue !== undefined) {
        logger?.(
            `[env] Resolved ${name} from process.env with value=${JSON.stringify(maskEnvironmentValue(currentValue))}`
        );
        return currentValue;
    }

    logger?.(`[env] ${name} not present in process.env; checking /proc/1/environ.`);
    const initEnv = readInitProcessEnvironment(logger);
    const initValue = initEnv?.[name];
    if (initValue !== undefined) {
        logger?.(
            `[env] Resolved ${name} from /proc/1/environ with value=${JSON.stringify(maskEnvironmentValue(initValue))}`
        );
        return initValue;
    }

    logger?.(`[env] ${name} was not found in process.env or /proc/1/environ.`);
    return undefined;
}

function replaceEnvPatterns(value: string, logger?: ResolutionLogger, context?: string): string {
    const matches = [...value.matchAll(ENV_PATTERN)].map((match) => match[1]);
    if (matches.length === 0) {
        logger?.(`[resolveEnv] No env placeholders found in ${JSON.stringify(value)}${formatResolutionContext(context)}`);
        return value;
    }

    logger?.(
        `[resolveEnv] Found env placeholders ${JSON.stringify(matches)} in ${JSON.stringify(value)}${formatResolutionContext(context)}`
    );

    const resolved = value.replace(ENV_PATTERN, (match, key: string) => {
        const replacement = getEnvironmentVariable(key, logger);
        if (replacement === undefined) {
            logger?.(`[resolveEnv] Leaving placeholder ${match} unchanged${formatResolutionContext(context)}`);
            return match;
        }
        logger?.(
            `[resolveEnv] Replaced ${match} with ${JSON.stringify(maskEnvironmentValue(replacement))}${formatResolutionContext(context)}`
        );
        return replacement;
    });

    logger?.(`[resolveEnv] Final value=${JSON.stringify(maskEnvironmentValue(resolved))}${formatResolutionContext(context)}`);
    return resolved;
}

function resolveTaskValue(
    value: string,
    workspacePath?: string,
    inputs?: Record<string, string>,
    logger?: ResolutionLogger,
    context?: string
): string {
    let resolved = value;

    logger?.(
        `[resolveTaskValue] Starting with value=${JSON.stringify(value)}, workspace=${workspacePath ?? '<undefined>'}, inputs=${JSON.stringify(inputs ?? {})}${formatResolutionContext(context)}`
    );

    if (workspacePath) {
        const nextValue = resolved.replace(/\$\{workspaceFolder\}/g, workspacePath);
        if (nextValue !== resolved) {
            logger?.(
                `[resolveTaskValue] Replaced workspaceFolder with ${JSON.stringify(workspacePath)}${formatResolutionContext(context)}`
            );
        }
        resolved = nextValue;
    } else if (resolved.includes('${workspaceFolder}')) {
        logger?.(`[resolveTaskValue] workspaceFolder placeholder left unresolved${formatResolutionContext(context)}`);
    }

    if (inputs) {
        for (const [key, inputValue] of Object.entries(inputs)) {
            const nextValue = replaceInputPatterns(resolved, key, inputValue);
            if (nextValue !== resolved) {
                logger?.(
                    `[resolveTaskValue] Replaced input ${key} with ${JSON.stringify(inputValue)}${formatResolutionContext(context)}`
                );
            }
            resolved = nextValue;
        }
    }

    const envResolved = replaceEnvPatterns(resolved, logger, context);
    logger?.(`[resolveTaskValue] Final resolved value=${JSON.stringify(maskEnvironmentValue(envResolved))}${formatResolutionContext(context)}`);
    return envResolved;
}

/** Prompt the user for each input variable, using input definitions from tasks.json when available. */
async function resolveInputVariables(
    varNames: string[],
    inputDefs: InputDefinition[],
    logger?: ResolutionLogger
): Promise<Record<string, string> | undefined> {
    const resolved: Record<string, string> = {};
    const defMap = new Map(inputDefs.map((d) => [d.id, d]));

    logger?.(`[resolveInputVariables] Resolving input variables ${JSON.stringify(varNames)}`);

    for (const name of varNames) {
        const def = defMap.get(name);
        let value: string | undefined;

        logger?.(
            `[resolveInputVariables] Prompting for ${name} using ${def?.type ?? 'prompt'} definition ${JSON.stringify(def ?? null)}`
        );

        if (def?.type === 'pickString' && def.options && def.options.length > 0) {
            value = await vscode.window.showQuickPick(def.options, {
                placeHolder: def.description ?? `Select value for ${name}`
            });
        } else {
            value = await vscode.window.showInputBox({
                prompt: def?.description ?? `Enter value for ${name}`,
                value: def?.default ?? ''
            });
        }

        if (value === undefined) {
            // User cancelled
            logger?.(`[resolveInputVariables] User cancelled while resolving ${name}`);
            return undefined;
        }
        resolved[name] = value;
        logger?.(`[resolveInputVariables] Resolved ${name}=${JSON.stringify(value)}`);
    }
    logger?.(`[resolveInputVariables] Final resolved inputs=${JSON.stringify(resolved)}`);
    return resolved;
}

function asHostScriptTask(task: vscode.Task): HostTask | undefined {
    const definition = task.definition as HostScriptTaskDefinition;
    if (definition.type !== HostScriptTaskProvider.type || typeof definition.command !== 'string') {
        return undefined;
    }

    return {
        label: task.name,
        command: definition.command,
        args: Array.isArray(definition.args) ? definition.args : [],
        options: definition.options
    };
}

function scoreHostScriptTaskCandidate(
    candidate: HostTask,
    taskName: string,
    fallbackDefinition: HostScriptTaskDefinition
): number {
    let score = 0;
    if (candidate.label === taskName) {
        score += 10;
    }
    if (candidate.command === fallbackDefinition.command) {
        score += 5;
    }

    const fallbackArgs = fallbackDefinition.args ?? [];
    if (JSON.stringify(candidate.args) === JSON.stringify(fallbackArgs)) {
        score += 3;
    }
    if (candidate.options?.env && Object.keys(candidate.options.env).length > 0) {
        score += 20;
    }
    if (candidate.options?.cwd) {
        score += 5;
    }
    return score;
}

async function resolveHostTaskFromVsCodeApi(
    taskName: string,
    fallbackDefinition: HostScriptTaskDefinition,
    runner: HostScriptRunner
): Promise<HostTask | undefined> {
    runner.logDebug(`[resolveTask] Fetching VS Code tasks for '${taskName}' via vscode.tasks.fetchTasks`);
    const tasks = await vscode.tasks.fetchTasks({ type: HostScriptTaskProvider.type });
    runner.logDebug(`[resolveTask] vscode.tasks.fetchTasks returned ${tasks.length} hostScript task(s)`);

    const candidates = tasks
        .map((task) => asHostScriptTask(task))
        .filter((task): task is HostTask => task !== undefined)
        .filter((task) => task.label === taskName);

    for (const candidate of candidates) {
        runner.logDebug(
            `[resolveTask] Candidate '${candidate.label}' command=${JSON.stringify(candidate.command)} args=${JSON.stringify(candidate.args)} options=${JSON.stringify(candidate.options ?? null)}`
        );
    }

    if (candidates.length === 0) {
        runner.logDebug(`[resolveTask] No VS Code task candidate matched '${taskName}'`);
        return undefined;
    }

    const bestCandidate = [...candidates].sort((left, right) => {
        return scoreHostScriptTaskCandidate(right, taskName, fallbackDefinition)
            - scoreHostScriptTaskCandidate(left, taskName, fallbackDefinition);
    })[0];

    runner.logDebug(
        `[resolveTask] Selected candidate for '${taskName}' with options=${JSON.stringify(bestCandidate.options ?? null)}`
    );
    return bestCandidate;
}

// ---------------------------------------------------------------------------
// Task provider — exposes host tasks as runnable VS Code tasks
// ---------------------------------------------------------------------------

export class HostScriptTaskProvider implements vscode.TaskProvider {
    static readonly type = 'hostScript';

    constructor(private runner: HostScriptRunner) {}

    async provideTasks(): Promise<vscode.Task[]> {
        const { tasks, inputs } = await this.runner.listTasks();

        return tasks.map((t) => {
            const definition: HostScriptTaskDefinition = {
                type: HostScriptTaskProvider.type,
                command: t.command,
                args: t.args,
                options: t.options
            };

            const task = new vscode.Task(
                definition,
                vscode.TaskScope.Workspace,
                t.label,
                'hostScript',
                new vscode.CustomExecution(
                    async () => new HostScriptTerminal(this.runner, t.label, t.args, t, inputs)
                )
            );
            task.detail = `Host command: ${t.command}`;
            return task;
        });
    }

    resolveTask(task: vscode.Task): vscode.Task | undefined {
        const definition = task.definition as HostScriptTaskDefinition;
        if (!definition.command) {
            return undefined;
        }

        return new vscode.Task(
            definition,
            task.scope ?? vscode.TaskScope.Workspace,
            task.name,
            'hostScript',
            new vscode.CustomExecution(
                async () => {
                    const { tasks, inputs } = await this.runner.listTasks();
                    const apiTask = await resolveHostTaskFromVsCodeApi(task.name, definition, this.runner);
                    const hostTask = apiTask ?? tasks.find((candidate) => candidate.label === task.name) ?? {
                        label: task.name,
                        command: definition.command,
                        args: definition.args ?? [],
                        options: definition.options
                    };
                    this.runner.logDebug(
                        `[resolveTask] Final host task for '${task.name}' options=${JSON.stringify(hostTask.options ?? null)}`
                    );
                    return new HostScriptTerminal(
                        this.runner,
                        task.name,
                        hostTask.args,
                        hostTask,
                        inputs
                    );
                }
            )
        );
    }
}

// ---------------------------------------------------------------------------
// Pseudoterminal — renders task output inside the VS Code terminal panel
// ---------------------------------------------------------------------------

class HostScriptTerminal implements vscode.Pseudoterminal {
    private writeEmitter = new vscode.EventEmitter<string>();
    private closeEmitter = new vscode.EventEmitter<number>();

    onDidWrite = this.writeEmitter.event;
    onDidClose = this.closeEmitter.event;

    constructor(
        private runner: HostScriptRunner,
        private label: string,
        private args: string[],
        private task?: HostTask,
        private inputDefs?: InputDefinition[]
    ) {}

    open(): void {
        void this.run();
    }

    close(): void {}

    private log(message: string): void {
        this.runner.logDebug(`[terminal:${this.label}] ${message}`);
        this.writeEmitter.fire(`[debug] ${message}\r\n`);
    }

    private async run(): Promise<void> {
        this.writeEmitter.fire(`Host task: ${this.label}\r\n`);

        let command = this.task?.command ?? '';
        let args = [...this.args];
        let resolvedInputs: Record<string, string> | undefined;

        // VS Code does NOT expose resolved values for CustomExecution tasks.
        // For hostScript tasks prefer ${hostInput:name} to avoid the extra
        // built-in VS Code prompt caused by ${input:name}.
        const allText = [command, ...args].join(' ');
        const inputNames = new Set<string>();
        let match: RegExpExecArray | null;
        const re = /\$\{(?:input|hostInput):([^}]+)\}/g;
        while ((match = re.exec(allText)) !== null) {
            inputNames.add(match[1]);
        }

        this.log(`Initial command=${JSON.stringify(command)}`);
        this.log(`Initial args=${JSON.stringify(args)}`);
        this.log(`Discovered input names=${JSON.stringify([...inputNames])}`);

        if (this.task && hasVsCodeInputVariables(this.task)) {
            this.log(
                'Note: ${input:...} in hostScript tasks triggers a VS Code prompt before this runner. ' +
                'Use ${hostInput:...} to avoid double prompting.'
            );
        }

        if (inputNames.size > 0) {
            this.log(`Inputs needed: ${[...inputNames].join(', ')}`);
            resolvedInputs = await resolveInputVariables([...inputNames], this.inputDefs ?? [], (message) => this.log(message));
            if (resolvedInputs === undefined) {
                this.log('Cancelled by user.');
                this.closeEmitter.fire(1);
                return;
            }
            // Substitute in command and args
            for (const [key, value] of Object.entries(resolvedInputs)) {
                command = replaceInputPatterns(command, key, value);
                args = args.map((arg) => replaceInputPatterns(arg, key, value));
                this.log(`Applied resolved input ${key}=${JSON.stringify(value)}`);
            }
            this.log(`Resolved inputs=${JSON.stringify(resolvedInputs)}`);
        }

        const resolvedOptions = this.task
            ? this.runner.resolveTaskOptions(this.task, resolvedInputs, (message) => this.log(message))
            : undefined;
        command = replaceEnvPatterns(command, (message) => this.log(message), 'terminal-command');
        args = args.map((arg, index) => replaceEnvPatterns(arg, (message) => this.log(message), `terminal-arg:${index}`));

        this.log(`Resolved command=${JSON.stringify(command)}`);
        this.log(`Resolved args=${JSON.stringify(args)}`);
        if (resolvedOptions?.cwd) {
            this.log(`Resolved cwd=${JSON.stringify(resolvedOptions.cwd)}`);
        }
        if (resolvedOptions?.env) {
            this.log(`Resolved env=${JSON.stringify(resolvedOptions.env)}`);
        }
        this.writeEmitter.fire('---\r\n');

        let wroteStdout = false;
        let wroteStderr = false;
        const writeTerminalChunk = (chunk: string): void => {
            this.writeEmitter.fire(chunk.replace(/\n/g, '\r\n'));
        };

        const result = await this.runner.runTaskStreaming(
            this.label,
            (event) => {
                if (event.type === 'stdout') {
                    wroteStdout = true;
                    writeTerminalChunk(event.data);
                    return;
                }

                if (event.type === 'exit') {
                    return;
                }

                if (!wroteStderr) {
                    this.writeEmitter.fire('\r\n--- stderr ---\r\n');
                    wroteStderr = true;
                }
                writeTerminalChunk(event.data);
            },
            [],
            resolvedInputs,
            command,
            args,
            resolvedOptions?.env,
            resolvedOptions?.cwd
        );

        if (result.output && !wroteStdout) {
            this.writeEmitter.fire(result.output.replace(/\n/g, '\r\n'));
        }
        if (result.error && !wroteStderr) {
            this.writeEmitter.fire('\r\n--- stderr ---\r\n');
            this.writeEmitter.fire(result.error.replace(/\n/g, '\r\n'));
        }

        this.writeEmitter.fire(`\r\n---\r\nExit code: ${result.exitCode}\r\n`);
        this.closeEmitter.fire(result.success ? 0 : 1);
    }
}

// ---------------------------------------------------------------------------
// Command registration
// ---------------------------------------------------------------------------

export function registerHostScriptCommands(
    context: vscode.ExtensionContext,
    runner: HostScriptRunner
): void {
    // Re-read config on change
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration((e) => {
            if (e.affectsConfiguration('pythonCopyQualifiedName.hostScripts')) {
                runner.updateConfiguration();
            }
        })
    );

    // Task provider
    context.subscriptions.push(
        vscode.tasks.registerTaskProvider(
            HostScriptTaskProvider.type,
            new HostScriptTaskProvider(runner)
        )
    );

    // --- List available host tasks ----------------------------------------
    context.subscriptions.push(
        vscode.commands.registerCommand(
            'python-copy-qualified-name.hostScripts.list',
            async () => {
                const { tasks, inputs } = await runner.listTasks();
                if (tasks.length === 0) {
                    vscode.window.showWarningMessage(
                        'No host tasks found. Is the host server running? Do you have tasks with "type": "hostScript" in tasks.json?'
                    );
                    return [];
                }
                const items = tasks.map((t) => ({
                    label: t.label,
                    description: t.command
                }));
                const selected = await vscode.window.showQuickPick(items, {
                    placeHolder: `${tasks.length} host task(s) available — pick one to run`,
                    canPickMany: false
                });
                if (!selected) {
                    return tasks;
                }
                // Resolve ${input:...} variables
                const task = tasks.find((t) => t.label === selected.label);
                let resolvedInputs: Record<string, string> | undefined;
                if (task) {
                    const varNames = extractInputVariables(task);
                    if (varNames.length > 0) {
                        runner.logDebug(
                            `[command:list] Resolving inputs for task '${task.label}' with variables=${JSON.stringify(varNames)}`
                        );
                        resolvedInputs = await resolveInputVariables(varNames, inputs, (message) => runner.logDebug(`[command:list] ${message}`));
                        if (resolvedInputs === undefined) {
                            return tasks; // cancelled
                        }
                    }
                }
                const resolvedOptions = task
                    ? runner.resolveTaskOptions(task, resolvedInputs, (message) => runner.logDebug(`[command:list] ${message}`))
                    : undefined;
                const result = await vscode.window.withProgress(
                    {
                        location: vscode.ProgressLocation.Notification,
                        title: `Running host task: ${selected.label}`,
                        cancellable: false
                    },
                    async () => runner.runTask(
                        selected.label,
                        [],
                        resolvedInputs,
                        undefined,
                        undefined,
                        resolvedOptions?.env,
                        resolvedOptions?.cwd
                    )
                );
                runner.showOutput(selected.label, result);
                return tasks;
            }
        )
    );

    // --- Interactive run (quick-pick) -------------------------------------
    context.subscriptions.push(
        vscode.commands.registerCommand(
            'python-copy-qualified-name.hostScripts.run',
            async () => {
                const alive = await runner.isServerRunning();
                if (!alive) {
                    vscode.window.showErrorMessage(
                        'Host task server is not running. Add to devcontainer.json initializeCommand: curl -fsSL https://raw.githubusercontent.com/nidheesh-doctorc/vscode-copy-python-fqn/main/host-scripts/ensure-server.sh | bash'
                    );
                    return null;
                }

                const { tasks, inputs } = await runner.listTasks();
                if (tasks.length === 0) {
                    vscode.window.showWarningMessage('No host tasks available.');
                    return null;
                }

                const selected = await vscode.window.showQuickPick(
                    tasks.map((t) => ({ label: t.label, description: t.command })),
                    { placeHolder: 'Select a host task to run' }
                );
                if (!selected) {
                    return null;
                }

                // Resolve ${input:...} variables
                const task = tasks.find((t) => t.label === selected.label);
                let resolvedInputs: Record<string, string> | undefined;
                if (task) {
                    const varNames = extractInputVariables(task);
                    if (varNames.length > 0) {
                        runner.logDebug(
                            `[command:run] Resolving inputs for task '${task.label}' with variables=${JSON.stringify(varNames)}`
                        );
                        resolvedInputs = await resolveInputVariables(varNames, inputs, (message) => runner.logDebug(`[command:run] ${message}`));
                        if (resolvedInputs === undefined) {
                            return null; // cancelled
                        }
                    }
                }
                const resolvedOptions = task
                    ? runner.resolveTaskOptions(task, resolvedInputs, (message) => runner.logDebug(`[command:run] ${message}`))
                    : undefined;

                return vscode.window.withProgress(
                    {
                        location: vscode.ProgressLocation.Notification,
                        title: `Running host task: ${selected.label}`,
                        cancellable: false
                    },
                    async () => {
                        const result = await runner.runTask(
                            selected.label,
                            [],
                            resolvedInputs,
                            undefined,
                            undefined,
                            resolvedOptions?.env,
                            resolvedOptions?.cwd
                        );
                        if (result.success) {
                            vscode.window.showInformationMessage(
                                `Host task '${selected.label}' completed.`
                            );
                        } else {
                            vscode.window.showErrorMessage(
                                `Host task '${selected.label}' failed: ${result.error}`
                            );
                        }
                        runner.showOutput(selected.label, result);
                        return result;
                    }
                );
            }
        )
    );

    // --- Run by label (programmatic / LLM use) ----------------------------
    context.subscriptions.push(
        vscode.commands.registerCommand(
            'python-copy-qualified-name.hostScripts.runByName',
            async (label: string, args?: string[]) => {
                if (!label) {
                    return { success: false, error: 'Task label is required' };
                }
                const { tasks } = await runner.listTasks();
                const task = tasks.find((candidate) => candidate.label === label);
                const resolvedOptions = task
                    ? runner.resolveTaskOptions(task, undefined, (message) => runner.logDebug(`[command:runByName] ${message}`))
                    : undefined;
                const result = await runner.runTask(
                    label,
                    args ?? [],
                    undefined,
                    undefined,
                    undefined,
                    resolvedOptions?.env,
                    resolvedOptions?.cwd
                );
                runner.showOutput(label, result);
                return result;
            }
        )
    );

    // --- Server status check ----------------------------------------------
    context.subscriptions.push(
        vscode.commands.registerCommand(
            'python-copy-qualified-name.hostScripts.status',
            async () => {
                const running = await runner.isServerRunning();
                if (running) {
                    vscode.window.showInformationMessage('Host task server is running.');
                } else {
                    vscode.window.showWarningMessage(
                        'Host task server is NOT running. Add to devcontainer.json initializeCommand: curl -fsSL https://raw.githubusercontent.com/nidheesh-doctorc/vscode-copy-python-fqn/main/host-scripts/ensure-server.sh | bash'
                    );
                }
                return { running };
            }
        )
    );
}
