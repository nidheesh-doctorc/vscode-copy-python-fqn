import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { PythonFileMonitor } from './fileMonitor';
import { HostScriptRunner, registerHostScriptCommands } from './hostScriptRunner';
import { installHostScriptCli } from './hostScriptCliInstaller';

const WORKTREE_TITLE_PREFIX = 'worktree';
const WORKTREE_IDENTITY_MODE_SETTING = 'pythonCopyQualifiedName.worktreeIdentity.mode';
const WORKTREE_WINDOW_TITLE_TEMPLATE_SETTING = 'pythonCopyQualifiedName.worktreeIdentity.windowTitleTemplate';

type WorktreeIdentityMode = 'workspaceSettings' | 'statusBar' | 'off';

type DoctorCTestKind =
    | 'unit'
    | 'channels'
    | 'selenium'
    | 'appium'
    | 'phleboAppium'
    | 'homeService';

interface TestRunMetadata {
    uri: vscode.Uri;
    modulePath: string;
    className?: string;
    methodName?: string;
}

interface ParsedClassTestMethods {
    className: string;
    classLine: number;
    methods: {
        methodName: string;
        methodLine: number;
    }[];
}

interface TestLaunchResult {
    completed: boolean;
    exitCode?: number;
    errorMessage?: string;
}

export function activate(context: vscode.ExtensionContext) {
    // Initialize file monitor
    const fileMonitor = new PythonFileMonitor();
    fileMonitor.start();
    context.subscriptions.push(fileMonitor);

    // Listen for configuration changes to restart the monitor
    const configChangeListener = vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('pythonCopyQualifiedName.fileMonitor')) {
            fileMonitor.restartPeriodicCheck();
        }
    });
    context.subscriptions.push(configChangeListener);

    let disposable = vscode.commands.registerCommand('python-copy-qualified-name.copyQualifiedName', async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            return;
        }

        const document = editor.document;
        const position = editor.selection.active;

        // Check if this is a Python file
        if (document.languageId !== 'python') {
            vscode.window.showWarningMessage('This command only works in Python files.');
            return;
        }

        try {
            const qualifiedName = await getQualifiedName(document, position);
            if (qualifiedName) {
                await vscode.env.clipboard.writeText(qualifiedName);
                vscode.window.showInformationMessage(`Copied: ${qualifiedName}`);
            } else {
                vscode.window.showWarningMessage('Could not determine qualified name at cursor position.');
            }
        } catch (error) {
            vscode.window.showErrorMessage(`Error: ${error}`);
        }
    });

    context.subscriptions.push(disposable);

    setupMethodTestRunner(context);

    // Initialize host script runner for devcontainer → host communication
    const hostScriptRunner = new HostScriptRunner();
    context.subscriptions.push(hostScriptRunner);
    registerHostScriptCommands(context, hostScriptRunner);
    void installHostScriptCli(context);

    setupWorktreeWindowIdentity(context);
}

function setupWorktreeWindowIdentity(context: vscode.ExtensionContext): void {
    const statusBarItem = vscode.window.createStatusBarItem(
        'python-copy-qualified-name.worktreeIdentity',
        vscode.StatusBarAlignment.Left,
        1000
    );
    statusBarItem.name = 'Worktree Identity';
    context.subscriptions.push(statusBarItem);

    const updateWindowIdentity = async (): Promise<void> => {
        const workspaceFolder = getPreferredWorkspaceFolder();
        if (!workspaceFolder) {
            statusBarItem.hide();
            return;
        }

        const mode = getWorktreeIdentityMode();

        if (mode === 'off') {
            statusBarItem.hide();
            return;
        }

        const worktreeName = await resolveWorktreeName(workspaceFolder.uri.fsPath);

        if (mode === 'statusBar') {
            updateWorktreeStatusBarItem(statusBarItem, worktreeName);
            return;
        }

        statusBarItem.hide();
        await updateWindowTitle(workspaceFolder, worktreeName);
        await updateWindowTitleColors(workspaceFolder, worktreeName);
    };

    void updateWindowIdentity();

    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration((event) => {
            if (
                event.affectsConfiguration(WORKTREE_IDENTITY_MODE_SETTING)
                || event.affectsConfiguration(WORKTREE_WINDOW_TITLE_TEMPLATE_SETTING)
            ) {
                void updateWindowIdentity();
            }
        })
    );
    context.subscriptions.push(
        vscode.workspace.onDidChangeWorkspaceFolders(() => {
            void updateWindowIdentity();
        })
    );
    context.subscriptions.push(
        vscode.window.onDidChangeActiveTextEditor(() => {
            void updateWindowIdentity();
        })
    );
    context.subscriptions.push(
        vscode.window.onDidChangeActiveColorTheme(() => {
            void updateWindowIdentity();
        })
    );
}

function getWorktreeIdentityMode(): WorktreeIdentityMode {
    const config = vscode.workspace.getConfiguration('pythonCopyQualifiedName');
    return config.get<WorktreeIdentityMode>('worktreeIdentity.mode', 'workspaceSettings');
}

function getPreferredWorkspaceFolder(): vscode.WorkspaceFolder | undefined {
    const activeDocument = vscode.window.activeTextEditor?.document;
    if (activeDocument) {
        const activeFolder = vscode.workspace.getWorkspaceFolder(activeDocument.uri);
        if (activeFolder) {
            return activeFolder;
        }
    }

    return vscode.workspace.workspaceFolders?.[0];
}

async function resolveWorktreeName(workspacePath: string): Promise<string> {
    const gitPath = path.join(workspacePath, '.git');

    try {
        const gitStats = await fs.promises.stat(gitPath);

        if (gitStats.isDirectory()) {
            return path.basename(workspacePath);
        }

        if (gitStats.isFile()) {
            const gitFileContent = await fs.promises.readFile(gitPath, 'utf8');
            const gitDirPath = parseGitDirPath(gitFileContent, workspacePath);
            if (gitDirPath) {
                return path.basename(gitDirPath);
            }
        }
    } catch {
        // Fall back to the workspace folder name when Git metadata is unavailable.
    }

    return path.basename(workspacePath);
}

function parseGitDirPath(gitFileContent: string, workspacePath: string): string | null {
    const gitDirPrefix = 'gitdir:';
    const gitDirLine = gitFileContent
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find((line) => line.toLowerCase().startsWith(gitDirPrefix));

    if (!gitDirLine) {
        return null;
    }

    const rawGitDirPath = gitDirLine.slice(gitDirPrefix.length).trim();
    if (!rawGitDirPath) {
        return null;
    }

    return path.isAbsolute(rawGitDirPath)
        ? rawGitDirPath
        : path.resolve(workspacePath, rawGitDirPath);
}

async function updateWindowTitle(workspaceFolder: vscode.WorkspaceFolder, worktreeName: string): Promise<void> {
    const title = getWindowTitleTemplate().replace(/\$\{worktreeName\}/g, worktreeName);
    const windowConfig = vscode.workspace.getConfiguration('window', workspaceFolder.uri);
    const currentTitle = windowConfig.get<string>('title');

    if (currentTitle === title) {
        return;
    }

    await windowConfig.update('title', title, vscode.ConfigurationTarget.Workspace);
}

function getWindowTitleTemplate(): string {
    const config = vscode.workspace.getConfiguration('pythonCopyQualifiedName');
    return config.get<string>('worktreeIdentity.windowTitleTemplate', `${WORKTREE_TITLE_PREFIX}: ${'${worktreeName}'}`);
}

async function updateWindowTitleColors(
    workspaceFolder: vscode.WorkspaceFolder,
    worktreeName: string
): Promise<void> {
    const workbenchConfig = vscode.workspace.getConfiguration('workbench', workspaceFolder.uri);
    const existingCustomizations = workbenchConfig.get<Record<string, unknown>>('colorCustomizations', {});
    const titleBarColors = buildTitleBarColorCustomizations(worktreeName, vscode.window.activeColorTheme.kind);

    let hasChanges = false;
    for (const [key, value] of Object.entries(titleBarColors)) {
        if (existingCustomizations[key] !== value) {
            hasChanges = true;
            break;
        }
    }

    if (!hasChanges) {
        return;
    }

    await workbenchConfig.update(
        'colorCustomizations',
        {
            ...existingCustomizations,
            ...titleBarColors
        },
        vscode.ConfigurationTarget.Workspace
    );
}

function updateWorktreeStatusBarItem(statusBarItem: vscode.StatusBarItem, worktreeName: string): void {
    statusBarItem.text = `$(git-branch) ${worktreeName}`;
    statusBarItem.tooltip = `Worktree: ${worktreeName}`;
    statusBarItem.color = undefined;
    statusBarItem.backgroundColor = getWorktreeStatusBarBackgroundColor(worktreeName);
    statusBarItem.show();
}

function getWorktreeStatusBarBackgroundColor(worktreeName: string): vscode.ThemeColor {
    const hash = hashString(worktreeName.toLowerCase());
    const themeColorId = (hash % 2) === 0
        ? 'statusBarItem.warningBackground'
        : 'statusBarItem.errorBackground';

    return new vscode.ThemeColor(themeColorId);
}

function buildTitleBarColorCustomizations(
    worktreeName: string,
    themeKind: vscode.ColorThemeKind
): Record<string, string> {
    const hash = hashString(worktreeName.toLowerCase());
    const hue = hash % 360;
    const saturation = 58 + (hash % 14);
    const activeLightness = themeKind === vscode.ColorThemeKind.Light ? 76 : 68;
    const inactiveLightness = Math.min(activeLightness + 6, 84);
    const activeBackground = hslToHex(hue, saturation, activeLightness);
    const inactiveBackground = hslToHex(hue, Math.max(42, saturation - 10), inactiveLightness);

    return {
        'titleBar.activeBackground': activeBackground,
        'titleBar.inactiveBackground': inactiveBackground,
        'titleBar.activeForeground': getContrastingTextColor(activeBackground),
        'titleBar.inactiveForeground': getContrastingTextColor(inactiveBackground)
    };
}

function hashString(value: string): number {
    let hash = 0;

    for (let index = 0; index < value.length; index++) {
        hash = ((hash << 5) - hash + value.charCodeAt(index)) | 0;
    }

    return Math.abs(hash);
}

function hslToHex(hue: number, saturation: number, lightness: number): string {
    const normalizedSaturation = saturation / 100;
    const normalizedLightness = lightness / 100;
    const chroma = (1 - Math.abs(2 * normalizedLightness - 1)) * normalizedSaturation;
    const hueSegment = hue / 60;
    const secondComponent = chroma * (1 - Math.abs((hueSegment % 2) - 1));
    const match = normalizedLightness - chroma / 2;

    let red = 0;
    let green = 0;
    let blue = 0;

    if (hueSegment >= 0 && hueSegment < 1) {
        red = chroma;
        green = secondComponent;
    } else if (hueSegment < 2) {
        red = secondComponent;
        green = chroma;
    } else if (hueSegment < 3) {
        green = chroma;
        blue = secondComponent;
    } else if (hueSegment < 4) {
        green = secondComponent;
        blue = chroma;
    } else if (hueSegment < 5) {
        red = secondComponent;
        blue = chroma;
    } else {
        red = chroma;
        blue = secondComponent;
    }

    const toHex = (value: number): string => {
        const normalizedValue = Math.round((value + match) * 255);
        return normalizedValue.toString(16).padStart(2, '0');
    };

    return `#${toHex(red)}${toHex(green)}${toHex(blue)}`;
}

function getContrastingTextColor(backgroundColor: string): string {
    const rgb = hexToRgb(backgroundColor);
    if (!rgb) {
        return '#111827';
    }

    const darkText = '#111827';
    const lightText = '#f8fafc';
    const darkContrast = getContrastRatio(backgroundColor, darkText);
    const lightContrast = getContrastRatio(backgroundColor, lightText);

    return darkContrast >= lightContrast ? darkText : lightText;
}

function hexToRgb(color: string): { red: number; green: number; blue: number } | null {
    const match = color.match(/^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i);
    if (!match) {
        return null;
    }

    return {
        red: parseInt(match[1], 16),
        green: parseInt(match[2], 16),
        blue: parseInt(match[3], 16)
    };
}

function getContrastRatio(colorA: string, colorB: string): number {
    const luminanceA = getRelativeLuminance(colorA);
    const luminanceB = getRelativeLuminance(colorB);
    const lighter = Math.max(luminanceA, luminanceB);
    const darker = Math.min(luminanceA, luminanceB);

    return (lighter + 0.05) / (darker + 0.05);
}

function getRelativeLuminance(color: string): number {
    const rgb = hexToRgb(color);
    if (!rgb) {
        return 0;
    }

    const components = [rgb.red, rgb.green, rgb.blue].map((component) => {
        const normalized = component / 255;
        return normalized <= 0.03928
            ? normalized / 12.92
            : Math.pow((normalized + 0.055) / 1.055, 2.4);
    });

    return (0.2126 * components[0]) + (0.7152 * components[1]) + (0.0722 * components[2]);
}

function setupMethodTestRunner(context: vscode.ExtensionContext): void {
    const testController = vscode.tests.createTestController('python-copy-qualified-name.testRunner', 'Python Method Tests');
    context.subscriptions.push(testController);

    const testMetadata = new Map<string, TestRunMetadata>();
    const sessionExitCodes = new Map<string, number>();

    const debugTracker = vscode.debug.registerDebugAdapterTrackerFactory('*', {
        createDebugAdapterTracker: (session) => {
            return {
                onDidSendMessage: (message: unknown) => {
                    if (!message || typeof message !== 'object') {
                        return;
                    }

                    const typedMessage = message as {
                        type?: string;
                        event?: string;
                        body?: { exitCode?: number };
                    };

                    if (typedMessage.type === 'event' && typedMessage.event === 'exited') {
                        const exitCode = typedMessage.body?.exitCode;
                        if (typeof exitCode === 'number') {
                            sessionExitCodes.set(session.id, exitCode);
                        }
                    }
                }
            };
        }
    });
    context.subscriptions.push(debugTracker);

    const refreshDocumentTests = async (document: vscode.TextDocument): Promise<void> => {
        if (document.languageId !== 'python' || !document.uri.fsPath.endsWith('.py')) {
            return;
        }

        await discoverDocumentTests(document, testController, testMetadata);
    };

    for (const document of vscode.workspace.textDocuments) {
        void refreshDocumentTests(document);
    }

    const openListener = vscode.workspace.onDidOpenTextDocument((document) => {
        void refreshDocumentTests(document);
    });
    context.subscriptions.push(openListener);

    const saveListener = vscode.workspace.onDidSaveTextDocument((document) => {
        void refreshDocumentTests(document);
    });
    context.subscriptions.push(saveListener);

    const runHandler = async (
        request: vscode.TestRunRequest,
        token: vscode.CancellationToken,
        shouldDebug: boolean
    ): Promise<void> => {
        const run = testController.createTestRun(request);

        const includeItems = request.include?.length
            ? request.include
            : Array.from(testController.items).map(([, item]) => item);
        const itemsToRun = flattenTestItems(includeItems);

        for (const item of itemsToRun) {
            if (token.isCancellationRequested) {
                break;
            }

            const metadata = testMetadata.get(item.id);
            if (!metadata) {
                continue;
            }

            run.started(item);
            const result = await launchDoctorCTest(metadata, shouldDebug, sessionExitCodes);
            if (result.completed && result.exitCode === 0) {
                run.passed(item);
            } else {
                const errorMessage = result.completed
                    ? `Test process exited with code ${result.exitCode ?? 'unknown'}.`
                    : result.errorMessage ?? 'Failed to start test launch configuration.';
                run.failed(item, new vscode.TestMessage(errorMessage));
            }
        }

        run.end();
    };

    const runProfile = testController.createRunProfile(
        'Run Python Method Test',
        vscode.TestRunProfileKind.Run,
        (request, token) => {
            void runHandler(request, token, false);
        },
        true
    );
    context.subscriptions.push(runProfile);

    const debugProfile = testController.createRunProfile(
        'Debug Python Method Test',
        vscode.TestRunProfileKind.Debug,
        (request, token) => {
            void runHandler(request, token, true);
        },
        true
    );
    context.subscriptions.push(debugProfile);
}

async function discoverDocumentTests(
    document: vscode.TextDocument,
    controller: vscode.TestController,
    metadataMap: Map<string, TestRunMetadata>
): Promise<void> {
    const rootFolder = getDoctorcWorkspaceFolder(document.uri);
    if (!rootFolder) {
        return;
    }

    const modulePath = getModulePathForWorkspace(document.uri, rootFolder.uri.fsPath);
    if (!modulePath) {
        return;
    }

    const fileId = `file:${document.uri.toString()}`;
    metadataMap.forEach((metadata, key) => {
        if (metadata.uri.toString() === document.uri.toString()) {
            metadataMap.delete(key);
        }
    });

    const existingFileItem = controller.items.get(fileId);
    if (existingFileItem) {
        controller.items.delete(fileId);
    }

    const parsedClassTests = parseClassTestMethods(document);
    if (parsedClassTests.length === 0) {
        return;
    }

    const fileItem = controller.createTestItem(fileId, path.basename(document.uri.fsPath), document.uri);
    fileItem.range = new vscode.Range(new vscode.Position(0, 0), new vscode.Position(0, 1));

    let hasTests = false;

    for (const classTests of parsedClassTests) {
        const classItemId = `${fileId}:class:${classTests.className}:${classTests.classLine}`;
        const classItem = controller.createTestItem(classItemId, classTests.className, document.uri);
        classItem.range = new vscode.Range(
            new vscode.Position(classTests.classLine, 0),
            new vscode.Position(classTests.classLine, 1)
        );

        for (const method of classTests.methods) {
            hasTests = true;

            const methodItemId = `${classItemId}:method:${method.methodName}:${method.methodLine}`;
            const methodItem = controller.createTestItem(methodItemId, method.methodName, document.uri);
            methodItem.range = new vscode.Range(
                new vscode.Position(method.methodLine, 0),
                new vscode.Position(method.methodLine, 1)
            );

            metadataMap.set(methodItemId, {
                uri: document.uri,
                modulePath,
                className: classTests.className,
                methodName: method.methodName
            });

            classItem.children.add(methodItem);
        }

        metadataMap.set(classItemId, {
            uri: document.uri,
            modulePath,
            className: classTests.className
        });
        fileItem.children.add(classItem);
    }

    if (hasTests) {
        metadataMap.set(fileId, {
            uri: document.uri,
            modulePath
        });
        controller.items.add(fileItem);
    }
}

function parseClassTestMethods(document: vscode.TextDocument): ParsedClassTestMethods[] {
    const classes: ParsedClassTestMethods[] = [];
    const classStack: { className: string; indent: number; classLine: number }[] = [];

    for (let index = 0; index < document.lineCount; index++) {
        const rawLine = document.lineAt(index).text;
        const trimmedLine = rawLine.trim();

        if (!trimmedLine || trimmedLine.startsWith('#')) {
            continue;
        }

        const indent = rawLine.length - rawLine.trimStart().length;

        while (classStack.length > 0 && indent <= classStack[classStack.length - 1].indent) {
            classStack.pop();
        }

        const classMatch = rawLine.match(/^\s*class\s+([A-Za-z_]\w*)\b/);
        if (classMatch) {
            const className = classMatch[1];
            classStack.push({ className, indent, classLine: index });
            classes.push({
                className,
                classLine: index,
                methods: []
            });
            continue;
        }

        const methodMatch = rawLine.match(/^\s*def\s+(test_[A-Za-z0-9_]*)\s*\(/);
        if (!methodMatch || classStack.length === 0) {
            continue;
        }

        const currentClass = classStack[classStack.length - 1];
        if (indent <= currentClass.indent) {
            continue;
        }

        const matchingClass = classes.find(
            (entry) => entry.className === currentClass.className && entry.classLine === currentClass.classLine
        );
        if (!matchingClass) {
            continue;
        }

        matchingClass.methods.push({
            methodName: methodMatch[1],
            methodLine: index
        });
    }

    return classes.filter((entry) => entry.methods.length > 0);
}

function flattenTestItems(items: readonly vscode.TestItem[]): vscode.TestItem[] {
    const stack = [...items];
    const leafItems: vscode.TestItem[] = [];

    while (stack.length > 0) {
        const item = stack.pop();
        if (!item) {
            continue;
        }

        if (item.children.size === 0) {
            leafItems.push(item);
            continue;
        }

        item.children.forEach((child) => stack.push(child));
    }

    return leafItems;
}

async function launchDoctorCTest(
    metadata: TestRunMetadata,
    shouldDebug: boolean,
    sessionExitCodes: Map<string, number>
): Promise<TestLaunchResult> {
    const rootFolder = getDoctorcWorkspaceFolder(metadata.uri);
    if (!rootFolder) {
        vscode.window.showWarningMessage('Could not find DoctorC workspace folder for this test file.');
        return {
            completed: false,
            errorMessage: 'Could not find DoctorC workspace folder for this test file.'
        };
    }

    const testTarget = buildTestTarget(metadata);
    const testKind = detectDoctorCTestKind(metadata.uri);
    const config = await getDebugConfigurationFromLaunchFile(rootFolder.uri.fsPath, testKind, testTarget);
    if (!config) {
        return {
            completed: false,
            errorMessage: 'Could not find matching launch configuration in .vscode/launch.json.'
        };
    }

    return startDebuggingAndWaitForExit(rootFolder, config, shouldDebug, sessionExitCodes);
}

async function startDebuggingAndWaitForExit(
    rootFolder: vscode.WorkspaceFolder,
    config: vscode.DebugConfiguration,
    shouldDebug: boolean,
    sessionExitCodes: Map<string, number>
): Promise<TestLaunchResult> {
    const runId = `python-copy-qualified-name:${Date.now()}:${Math.random().toString(16).slice(2)}`;
    const debugConfig = {
        ...config,
        __pythonCopyQualifiedNameRunId: runId
    };

    return new Promise<TestLaunchResult>(async (resolve) => {
        let startedSessionId: string | undefined;
        let completed = false;

        const cleanup = (): void => {
            startListener.dispose();
            terminateListener.dispose();
        };

        const startListener = vscode.debug.onDidStartDebugSession((session) => {
            if (session.configuration?.__pythonCopyQualifiedNameRunId === runId) {
                startedSessionId = session.id;
            }
        });

        const terminateListener = vscode.debug.onDidTerminateDebugSession((session) => {
            if (session.configuration?.__pythonCopyQualifiedNameRunId !== runId && session.id !== startedSessionId) {
                return;
            }

            const exitCode = sessionExitCodes.get(session.id);
            sessionExitCodes.delete(session.id);
            completed = true;
            cleanup();
            resolve({
                completed: true,
                exitCode
            });
        });

        const started = await vscode.debug.startDebugging(rootFolder, debugConfig, {
            noDebug: !shouldDebug
        });

        if (!started) {
            cleanup();
            resolve({
                completed: false,
                errorMessage: 'Unable to start debugging session.'
            });
            return;
        }

        setTimeout(() => {
            if (completed) {
                return;
            }
            cleanup();
            resolve({
                completed: false,
                errorMessage: 'Timed out waiting for test process to finish.'
            });
        }, 1000 * 60 * 60);
    });
}

async function getDebugConfigurationFromLaunchFile(
    workspacePath: string,
    testKind: DoctorCTestKind,
    testTarget: string
): Promise<vscode.DebugConfiguration | null> {
    const launchPath = path.join(workspacePath, '.vscode', 'launch.json');
    const launchFileExists = await fs.promises
        .stat(launchPath)
        .then(() => true)
        .catch(() => false);

    if (!launchFileExists) {
        return null;
    }

    const rawLaunchContent = await fs.promises.readFile(launchPath, 'utf8');
    const parsedLaunch = parseJsonc(rawLaunchContent) as { configurations?: vscode.DebugConfiguration[] };
    const launchConfigurations = parsedLaunch.configurations;

    if (!Array.isArray(launchConfigurations)) {
        return null;
    }

    const launchName = getLaunchNameForTestKind(testKind);
    const selectedConfig = launchConfigurations.find((config) => config.name === launchName);
    if (!selectedConfig) {
        return null;
    }

    const clonedConfig = JSON.parse(JSON.stringify(selectedConfig)) as vscode.DebugConfiguration;
    const resolvedConfig = replaceDynamicValues(clonedConfig, workspacePath, testTarget);
    return resolvedConfig;
}

function getLaunchNameForTestKind(testKind: DoctorCTestKind): string {
    switch (testKind) {
        case 'channels':
            return 'DrC: Channels Test';
        case 'selenium':
            return 'DrC: Selenium Test';
        case 'appium':
            return 'DrC: Appium Test';
        case 'phleboAppium':
            return 'DrC: Phlebo Appium Test';
        case 'homeService':
            return 'DrC: HomeService Test';
        case 'unit':
        default:
            return 'DrC: Unit Test';
    }
}

function replaceDynamicValues(
    config: vscode.DebugConfiguration,
    workspacePath: string,
    testTarget: string
): vscode.DebugConfiguration {
    return replaceDynamicValue(config, workspacePath, testTarget) as vscode.DebugConfiguration;
}

function replaceDynamicValue(value: unknown, workspacePath: string, testTarget: string): unknown {
    if (typeof value === 'string') {
        const withWorkspacePath = value.replace(/\$\{workspaceFolder\}/g, workspacePath);
        return withWorkspacePath.replace(/\$\{input:([^}]+)\}/g, (_match, inputName: string) => {
            if (inputName === 'visualRegressionMode') {
                return 'assert';
            }
            return testTarget;
        });
    }

    if (Array.isArray(value)) {
        return value.map((entry) => replaceDynamicValue(entry, workspacePath, testTarget));
    }

    if (value && typeof value === 'object') {
        const resolved: Record<string, unknown> = {};
        for (const [key, nestedValue] of Object.entries(value as Record<string, unknown>)) {
            resolved[key] = replaceDynamicValue(nestedValue, workspacePath, testTarget);
        }
        return resolved;
    }

    return value;
}

function parseJsonc(content: string): unknown {
    let output = '';
    let inString = false;
    let escape = false;
    let inSingleLineComment = false;
    let inMultiLineComment = false;

    for (let index = 0; index < content.length; index++) {
        const current = content[index];
        const next = content[index + 1];

        if (inSingleLineComment) {
            if (current === '\n') {
                inSingleLineComment = false;
                output += current;
            }
            continue;
        }

        if (inMultiLineComment) {
            if (current === '*' && next === '/') {
                inMultiLineComment = false;
                index++;
            }
            continue;
        }

        if (inString) {
            output += current;
            if (escape) {
                escape = false;
            } else if (current === '\\') {
                escape = true;
            } else if (current === '"') {
                inString = false;
            }
            continue;
        }

        if (current === '"') {
            inString = true;
            output += current;
            continue;
        }

        if (current === '/' && next === '/') {
            inSingleLineComment = true;
            index++;
            continue;
        }

        if (current === '/' && next === '*') {
            inMultiLineComment = true;
            index++;
            continue;
        }

        output += current;
    }

    const withoutTrailingCommas = output.replace(/,\s*([}\]])/g, '$1');
    return JSON.parse(withoutTrailingCommas);
}

function buildTestTarget(metadata: TestRunMetadata): string {
    const parts = [metadata.modulePath];
    if (metadata.className) {
        parts.push(metadata.className);
    }
    if (metadata.methodName) {
        parts.push(metadata.methodName);
    }
    return parts.join('.');
}

function detectDoctorCTestKind(uri: vscode.Uri): DoctorCTestKind {
    const lowerPath = uri.fsPath.replace(/\\/g, '/').toLowerCase();
    const filename = path.basename(lowerPath);

    if (lowerPath.includes('/home_service_microservice/')) {
        return 'homeService';
    }
    if (filename.startsWith('phlebo_appiumselenium')) {
        return 'phleboAppium';
    }
    if (filename.startsWith('doctorc_appiumselenium')) {
        return 'appium';
    }
    if (filename.startsWith('selenium')) {
        return 'selenium';
    }
    if (filename.startsWith('channels')) {
        return 'channels';
    }
    return 'unit';
}

function getDoctorcWorkspaceFolder(uri: vscode.Uri): vscode.WorkspaceFolder | undefined {
    const directWorkspace = vscode.workspace.getWorkspaceFolder(uri);
    if (directWorkspace && isDoctorcRoot(directWorkspace.uri.fsPath)) {
        return directWorkspace;
    }

    return vscode.workspace.workspaceFolders?.find((folder) => {
        const rootPath = folder.uri.fsPath;
        const isParent = uri.fsPath.startsWith(`${rootPath}${path.sep}`) || uri.fsPath === rootPath;
        return isParent && isDoctorcRoot(rootPath);
    });
}

function isDoctorcRoot(folderPath: string): boolean {
    return fs.existsSync(path.join(folderPath, 'manage.py'));
}

function getModulePathForWorkspace(uri: vscode.Uri, workspaceRoot: string): string | null {
    if (!uri.fsPath.startsWith(workspaceRoot)) {
        return null;
    }

    const relativePath = path.relative(workspaceRoot, uri.fsPath);
    return relativePath
        .replace(/\\/g, '/')
        .replace(/\.py$/, '')
        .replace(/\//g, '.');
}

async function getQualifiedName(document: vscode.TextDocument, position: vscode.Position): Promise<string | null> {
    const text = document.getText();
    const lines = text.split('\n');
    const currentLine = position.line;

    // Get module path from file path
    const modulePath = getModulePath(document.uri);
    
    // Find the current function/method context
    const context = findContext(lines, currentLine);
    
    if (context) {
        return `${modulePath}.${context}`;
    }
    
    return null;
}

function getModulePath(uri: vscode.Uri): string {
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
    if (!workspaceFolder) {
        return path.basename(uri.fsPath, '.py');
    }

    return getModulePathForWorkspace(uri, workspaceFolder.uri.fsPath) ?? path.basename(uri.fsPath, '.py');
}

function findContext(lines: string[], currentLine: number): string | null {
    const contexts: { name: string, indent: number, type: 'class' | 'function' }[] = [];
    
    // Work backwards from current line to find enclosing functions/classes
    for (let i = currentLine; i >= 0; i--) {
        const line = lines[i].trimStart();
        const indent = lines[i].length - line.length;

        // Skip empty lines and comments
        if (!line || line.startsWith('#')) {
            continue;
        }

        // Check if this line defines a class or function
        const classMatch = line.match(/^class\s+(\w+)/);
        const funcMatch = line.match(/^(?:async\s+)?def\s+(\w+)/);

        if (classMatch) {
            contexts.push({ name: classMatch[1], indent, type: 'class' });
        } else if (funcMatch) {
            contexts.push({ name: funcMatch[1], indent, type: 'function' });
        }
    }

    if (contexts.length === 0) {
        return null;
    }

    // Sort by indentation (outermost first) and build the qualified name
    contexts.sort((a, b) => a.indent - b.indent);
    
    // Filter to only include relevant contexts (each must contain the next)
    const relevantContexts: string[] = [];
    let lastIndent = -1;
    
    for (const context of contexts) {
        if (context.indent > lastIndent) {
            relevantContexts.push(context.name);
            lastIndent = context.indent;
        }
    }

    return relevantContexts.join('.');
}

export function deactivate() {}
