import * as vscode from 'vscode';
import * as http from 'http';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface HostTask {
    label: string;
    command: string;
    args: string[];
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

interface HostScriptTaskDefinition extends vscode.TaskDefinition {
    command: string;
    args?: string[];
}

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
    }

    private get baseUrl(): string {
        return `${this.host}:${this.port}`;
    }

    /** Resolve the host-side workspace path for the current VS Code workspace. */
    private getWorkspacePath(): string | undefined {
        const folders = vscode.workspace.workspaceFolders;
        if (!folders || folders.length === 0) {
            return undefined;
        }
        // 1. Explicit override in settings
        const config = vscode.workspace.getConfiguration('pythonCopyQualifiedName.hostScripts');
        const override = config.get<string>('hostWorkspacePath', '');
        if (override) {
            return override;
        }
        // 2. HOST_PROJECT_PATH is set via remoteEnv in devcontainer.json
        //    to pass the host-side workspace path into the container.
        const hostPath = process.env.HOST_PROJECT_PATH;
        if (hostPath) {
            return hostPath;
        }
        // 3. Fallback: use fsPath directly (correct when running on the host)
        const containerPath = folders[0].uri.fsPath;
        if (containerPath.startsWith('/workspaces/')) {
            this.outputChannel.appendLine(
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
            return { tasks: [], inputs: [] };
        }
        try {
            const body = JSON.stringify({ workspace });
            const res = await httpRequest('POST', this.host, this.port, '/tasks', body);
            if (res.status !== 200) {
                return { tasks: [], inputs: [] };
            }
            const data = JSON.parse(res.body) as { tasks: HostTask[]; inputs: InputDefinition[] };
            return { tasks: data.tasks ?? [], inputs: data.inputs ?? [] };
        } catch {
            return { tasks: [], inputs: [] };
        }
    }

    /** Run a host task by its label. */
    public async runTask(
        label: string,
        args: string[] = [],
        inputs?: Record<string, string>,
        resolvedCommand?: string,
        resolvedArgs?: string[]
    ): Promise<TaskRunResult> {
        const workspace = this.getWorkspacePath();
        if (!workspace) {
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
            const body = JSON.stringify(payload);
            this.outputChannel.appendLine(`[runTask] label=${label} workspace=${workspace}`);
            if (resolvedCommand) {
                this.outputChannel.appendLine(`[runTask] resolvedCommand=${resolvedCommand}`);
            }
            if (resolvedArgs) {
                this.outputChannel.appendLine(`[runTask] resolvedArgs=${JSON.stringify(resolvedArgs)}`);
            }
            if (inputs && Object.keys(inputs).length > 0) {
                this.outputChannel.appendLine(`[runTask] inputs=${JSON.stringify(inputs)}`);
            }
            const res = await httpRequest('POST', this.host, this.port, '/run', body);
            this.outputChannel.appendLine(`[runTask] response status=${res.status}`);
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
            const res = await httpRequest('GET', this.host, this.port, '/health');
            return res.status === 200;
        } catch {
            return false;
        }
    }

    /** Re-read settings after a configuration change. */
    public updateConfiguration(): void {
        const config = vscode.workspace.getConfiguration('pythonCopyQualifiedName.hostScripts');
        const defaultHost = detectDefaultHost();
        this.host = config.get<string>('host', '') || defaultHost;
        this.port = config.get<number>('port', 7890);
    }

    /** Show output in the dedicated output channel. */
    public showOutput(heading: string, result: TaskRunResult): void {
        this.outputChannel.clear();
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
// Input variable resolution — detects ${input:XYZ} / ${hostInput:XYZ}
// ---------------------------------------------------------------------------

const INPUT_PATTERN = /\$\{(?:input|hostInput):([^}]+)\}/g;
const VSCODE_INPUT_PATTERN = /\$\{input:([^}]+)\}/g;

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

/** Prompt the user for each input variable, using input definitions from tasks.json when available. */
async function resolveInputVariables(
    varNames: string[],
    inputDefs: InputDefinition[]
): Promise<Record<string, string> | undefined> {
    const resolved: Record<string, string> = {};
    const defMap = new Map(inputDefs.map((d) => [d.id, d]));

    for (const name of varNames) {
        const def = defMap.get(name);
        let value: string | undefined;

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
            return undefined;
        }
        resolved[name] = value;
    }
    return resolved;
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
                command: t.command
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

        const hostTask: HostTask = {
            label: task.name,
            command: definition.command,
            args: definition.args ?? []
        };

        return new vscode.Task(
            definition,
            task.scope ?? vscode.TaskScope.Workspace,
            task.name,
            'hostScript',
            new vscode.CustomExecution(
                async () => {
                    const { inputs } = await this.runner.listTasks();
                    return new HostScriptTerminal(
                        this.runner,
                        task.name,
                        definition.args ?? [],
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

    private async run(): Promise<void> {
        this.writeEmitter.fire(`Host task: ${this.label}\r\n`);

        let command = this.task?.command ?? '';
        let args = [...this.args];

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

        if (this.task && hasVsCodeInputVariables(this.task)) {
            this.writeEmitter.fire(
                'Note: ${input:...} in hostScript tasks triggers a VS Code prompt before this runner. ' +
                'Use ${hostInput:...} to avoid double prompting.\r\n'
            );
        }

        if (inputNames.size > 0) {
            this.writeEmitter.fire(`Inputs needed: ${[...inputNames].join(', ')}\r\n`);
            const resolved = await resolveInputVariables([...inputNames], this.inputDefs ?? []);
            if (resolved === undefined) {
                this.writeEmitter.fire('Cancelled by user.\r\n');
                this.closeEmitter.fire(1);
                return;
            }
            // Substitute in command and args
            for (const [key, value] of Object.entries(resolved)) {
                command = replaceInputPatterns(command, key, value);
                args = args.map((arg) => replaceInputPatterns(arg, key, value));
            }
            this.writeEmitter.fire(`Resolved inputs: ${JSON.stringify(resolved)}\r\n`);
        }

        this.writeEmitter.fire(`Command: ${command}\r\n`);
        this.writeEmitter.fire(`Args: ${JSON.stringify(args)}\r\n`);
        this.writeEmitter.fire('---\r\n');

        const result = await this.runner.runTask(this.label, [], undefined, command, args);

        if (result.output) {
            this.writeEmitter.fire(result.output.replace(/\n/g, '\r\n'));
        }
        if (result.error) {
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
                        resolvedInputs = await resolveInputVariables(varNames, inputs);
                        if (resolvedInputs === undefined) {
                            return tasks; // cancelled
                        }
                    }
                }
                const result = await vscode.window.withProgress(
                    {
                        location: vscode.ProgressLocation.Notification,
                        title: `Running host task: ${selected.label}`,
                        cancellable: false
                    },
                    async () => runner.runTask(selected.label, [], resolvedInputs)
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
                        resolvedInputs = await resolveInputVariables(varNames, inputs);
                        if (resolvedInputs === undefined) {
                            return null; // cancelled
                        }
                    }
                }

                return vscode.window.withProgress(
                    {
                        location: vscode.ProgressLocation.Notification,
                        title: `Running host task: ${selected.label}`,
                        cancellable: false
                    },
                    async () => {
                        const result = await runner.runTask(selected.label, [], resolvedInputs);
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
                const result = await runner.runTask(label, args ?? []);
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
