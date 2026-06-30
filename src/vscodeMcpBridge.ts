import * as vscode from 'vscode';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';

interface BridgeRegistry {
    port: number;
    pid: number;
    workspaceFolders: string[];
    extensionId: string;
    updatedAt: string;
}

interface RunTaskRequest {
    label: string;
    type?: string;
    workspaceFolder?: string;
}

interface StartDebugRequest {
    name: string;
    workspaceFolder?: string;
    noDebug?: boolean;
}

function getVscodeMcpRegistryDir(): string {
    return path.join(os.homedir(), '.agents', 'doctorc-vscode-mcp');
}

function getVscodeMcpRegistryPath(workspacePath: string): string {
    const hash = crypto.createHash('sha256').update(workspacePath).digest('hex').slice(0, 24);
    return path.join(getVscodeMcpRegistryDir(), `${hash}.json`);
}

function getWorkspaceFolders(): readonly vscode.WorkspaceFolder[] {
    return vscode.workspace.workspaceFolders ?? [];
}

function getWorkspaceFolderPaths(): string[] {
    return getWorkspaceFolders().map((folder) => folder.uri.fsPath);
}

function findWorkspaceFolder(workspaceFolderPath: string | undefined): vscode.WorkspaceFolder | undefined {
    if (!workspaceFolderPath) {
        return undefined;
    }
    return getWorkspaceFolders().find((folder) => folder.uri.fsPath === workspaceFolderPath);
}

function serializeTaskScope(scope: vscode.Task['scope']): string {
    if (!scope) {
        return 'unknown';
    }
    if (typeof scope === 'number') {
        return scope === vscode.TaskScope.Global
            ? 'global'
            : scope === vscode.TaskScope.Workspace
                ? 'workspace'
                : String(scope);
    }
    return scope.uri.fsPath;
}

function serializeTask(task: vscode.Task): Record<string, unknown> {
    return {
        label: task.name,
        source: task.source,
        scope: serializeTaskScope(task.scope),
        type: typeof task.definition.type === 'string' ? task.definition.type : undefined,
        detail: task.detail
    };
}

function taskMatchesWorkspaceFolder(task: vscode.Task, workspaceFolder: vscode.WorkspaceFolder | undefined): boolean {
    if (!workspaceFolder) {
        return true;
    }
    return typeof task.scope === 'object' && task.scope.uri.fsPath === workspaceFolder.uri.fsPath;
}

function serializeDebugConfiguration(
    config: vscode.DebugConfiguration,
    workspaceFolder: vscode.WorkspaceFolder | undefined
): Record<string, unknown> {
    return {
        name: config.name,
        type: config.type,
        request: config.request,
        workspaceFolder: workspaceFolder?.uri.fsPath
    };
}

async function readRequestBody(req: http.IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    if (chunks.length === 0) {
        return {};
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export class VscodeMcpBridge implements vscode.Disposable {
    private readonly output = vscode.window.createOutputChannel('DoctorC VS Code HTTP Bridge');
    private readonly registryPaths = new Set<string>();
    private server?: http.Server;
    private port?: number;
    public readonly ready: Promise<void>;

    constructor(private readonly context: vscode.ExtensionContext) {
        this.ready = this.start();
    }

    public async getMcpServerEnv(): Promise<Record<string, string>> {
        await this.ready;
        return {
            DOCTORC_VSCODE_MCP_REGISTRY_DIR: getVscodeMcpRegistryDir(),
            DOCTORC_VSCODE_WORKSPACE_FOLDERS: JSON.stringify(getWorkspaceFolderPaths()),
            DOCTORC_VSCODE_EXTENSION_ID: this.context.extension.id
        };
    }

    public dispose(): void {
        for (const registryPath of this.registryPaths) {
            try {
                fs.unlinkSync(registryPath);
            } catch {
                // Registry files are best-effort cleanup.
            }
        }
        this.server?.close();
        this.output.dispose();
    }

    public async refreshRegistry(): Promise<void> {
        if (!this.port) {
            return;
        }

        const workspaceFolders = getWorkspaceFolderPaths();
        const hostProjectPath = process.env.HOST_PROJECT_PATH;
        const allWorkspaceFolders = hostProjectPath && !workspaceFolders.includes(hostProjectPath)
            ? [...workspaceFolders, hostProjectPath]
            : workspaceFolders;
        const registry: BridgeRegistry = {
            port: this.port,
            pid: process.pid,
            workspaceFolders: allWorkspaceFolders,
            extensionId: this.context.extension.id,
            updatedAt: new Date().toISOString()
        };

        fs.mkdirSync(getVscodeMcpRegistryDir(), { recursive: true });

        for (const workspacePath of workspaceFolders) {
            const registryPath = getVscodeMcpRegistryPath(workspacePath);
            fs.writeFileSync(registryPath, `${JSON.stringify(registry, null, 2)}\n`, 'utf8');
            this.registryPaths.add(registryPath);
        }
    }

    private async start(): Promise<void> {
        this.server = http.createServer((req, res) => {
            void this.handleRequest(req, res);
        });

        const worktreeHostPort = process.env.WORKTREE_HOST_PORT ? parseInt(process.env.WORKTREE_HOST_PORT, 10) : undefined;
        const listenPort = worktreeHostPort ? worktreeHostPort + 1500 : 0;

        await new Promise<void>((resolve, reject) => {
            this.server?.once('error', reject);
            this.server?.listen(listenPort, '127.0.0.1', () => resolve());
        });

        const address = this.server.address();
        if (!address || typeof address === 'string') {
            throw new Error('DoctorC VS Code MCP bridge did not receive a TCP port.');
        }

        this.port = address.port;
        await this.refreshRegistry();
        this.output.appendLine(`Bridge listening on 127.0.0.1:${this.port}`);
    }

    private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        try {
            const url = new URL(req.url ?? '/', 'http://127.0.0.1');
            if (req.method === 'GET' && url.pathname === '/status') {
                this.sendJson(res, 200, this.getStatus());
                return;
            }
            if (req.method === 'GET' && url.pathname === '/tasks') {
                this.sendJson(res, 200, await this.listTasks(url.searchParams.get('type') ?? undefined));
                return;
            }
            if (req.method === 'POST' && url.pathname === '/tasks/run') {
                this.sendJson(res, 200, await this.runTask(await readRequestBody(req) as RunTaskRequest));
                return;
            }
            if (req.method === 'GET' && url.pathname === '/debug/configurations') {
                this.sendJson(res, 200, this.listDebugConfigurations());
                return;
            }
            if (req.method === 'POST' && url.pathname === '/debug/start') {
                this.sendJson(res, 200, await this.startDebugging(await readRequestBody(req) as StartDebugRequest));
                return;
            }

            this.sendJson(res, 404, { ok: false, error: `Unknown route: ${req.method} ${url.pathname}` });
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            this.output.appendLine(`Request failed: ${message}`);
            this.sendJson(res, 500, { ok: false, error: message });
        }
    }

    private sendJson(res: http.ServerResponse, statusCode: number, value: unknown): void {
        const body = JSON.stringify(value);
        res.writeHead(statusCode, {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body)
        });
        res.end(body);
    }

    private getStatus(): Record<string, unknown> {
        return {
            ok: true,
            extensionId: this.context.extension.id,
            workspaceFolders: getWorkspaceFolderPaths(),
            port: this.port,
            pid: process.pid
        };
    }

    private async listTasks(type: string | undefined): Promise<Record<string, unknown>> {
        const tasks = await vscode.tasks.fetchTasks(type ? { type } : undefined);
        return {
            ok: true,
            workspaceFolders: getWorkspaceFolderPaths(),
            tasks: tasks.map(serializeTask)
        };
    }

    private async runTask(request: RunTaskRequest): Promise<Record<string, unknown>> {
        if (!request.label) {
            throw new Error('Task label is required.');
        }

        const workspaceFolder = findWorkspaceFolder(request.workspaceFolder);
        if (request.workspaceFolder && !workspaceFolder) {
            throw new Error(`Workspace folder is not open in this window: ${request.workspaceFolder}`);
        }

        const tasks = await vscode.tasks.fetchTasks(request.type ? { type: request.type } : undefined);
        const matches = tasks.filter((task) =>
            task.name === request.label && taskMatchesWorkspaceFolder(task, workspaceFolder)
        );

        if (matches.length === 0) {
            return {
                ok: false,
                error: `No VS Code task matched label: ${request.label}`,
                availableTasks: tasks.map(serializeTask)
            };
        }
        if (matches.length > 1) {
            return {
                ok: false,
                error: `Multiple VS Code tasks matched label: ${request.label}`,
                matches: matches.map(serializeTask)
            };
        }

        const execution = await vscode.tasks.executeTask(matches[0]);
        return {
            ok: true,
            started: true,
            task: serializeTask(execution.task)
        };
    }

    private listDebugConfigurations(): Record<string, unknown> {
        const folders = getWorkspaceFolders();
        const configurations = folders.flatMap((folder) => {
            const launch = vscode.workspace.getConfiguration('launch', folder.uri);
            const configs = launch.get<vscode.DebugConfiguration[]>('configurations', []);
            return configs.map((config) => serializeDebugConfiguration(config, folder));
        });

        return {
            ok: true,
            workspaceFolders: getWorkspaceFolderPaths(),
            configurations
        };
    }

    private async startDebugging(request: StartDebugRequest): Promise<Record<string, unknown>> {
        if (!request.name) {
            throw new Error('Debug configuration name is required.');
        }

        const workspaceFolder = findWorkspaceFolder(request.workspaceFolder) ?? getWorkspaceFolders()[0];
        const started = await vscode.debug.startDebugging(
            workspaceFolder,
            request.name,
            { noDebug: request.noDebug }
        );

        return {
            ok: started,
            started,
            name: request.name,
            workspaceFolder: workspaceFolder?.uri.fsPath
        };
    }
}
