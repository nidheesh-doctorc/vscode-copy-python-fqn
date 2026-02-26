import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { PythonFileMonitor } from './fileMonitor';

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
    const config = buildDebugConfiguration(rootFolder.uri.fsPath, testKind, testTarget);

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

function buildDebugConfiguration(
    workspacePath: string,
    testKind: DoctorCTestKind,
    testTarget: string
): vscode.DebugConfiguration {
    const envFile = path.join(workspacePath, '.devcontainer/.env.test');

    const baseConfig: vscode.DebugConfiguration = {
        name: 'DoctorC Test',
        type: 'debugpy',
        request: 'launch',
        autoStartBrowser: false,
        envFile
    };

    if (testKind === 'homeService') {
        return {
            ...baseConfig,
            name: 'DrC: HomeService Test',
            program: path.join(workspacePath, 'manage_homeservice.py'),
            args: [
                'test',
                '--noinput',
                '--tag=home_service',
                '--settings=home_service_microservice.settings',
                '--keepdb',
                testTarget
            ]
        };
    }

    const config: vscode.DebugConfiguration = {
        ...baseConfig,
        program: path.join(workspacePath, 'manage.py'),
        args: ['test', '--noinput']
    };

    switch (testKind) {
        case 'channels':
            config.name = 'DrC: Channels Test';
            config.env = {
                ENABLE_CHANNELS: '1'
            };
            config.args = [
                'test',
                '--noinput',
                '--pattern=channels*',
                '--settings=doctorc.settings',
                '--keepdb',
                testTarget
            ];
            break;
        case 'selenium':
            config.name = 'DrC: Selenium Test';
            config.args = [
                'test',
                '--noinput',
                '--pattern=selenium*',
                '--settings=doctorc.settings',
                '--keepdb',
                '--visualRegressionMode=assert',
                testTarget
            ];
            break;
        case 'appium':
            config.name = 'DrC: Appium Test';
            config.env = {
                APP_TEST_SERVER_PORT: '13513',
                APPIUM_SERVER: 'http://host.docker.internal:4723/wd/hub',
                APP_SERVER_HOST: '10.0.2.2',
                RUNNING_IN_ANDROID: '1'
            };
            config.args = [
                'test',
                '--noinput',
                '--pattern=doctorc_appiumselenium*',
                '--settings=doctorc.settings',
                '--keepdb',
                '--visualRegressionMode=assert',
                testTarget
            ];
            break;
        case 'phleboAppium':
            config.name = 'DrC: Phlebo Appium Test';
            config.env = {
                APP_TEST_SERVER_PORT: '13513',
                APPIUM_SERVER: 'http://host.docker.internal:4723/wd/hub',
                APP_SERVER_HOST: '10.0.2.2',
                RUNNING_IN_ANDROID: '1'
            };
            config.args = [
                'test',
                '--noinput',
                '--pattern=phlebo_appiumselenium*',
                '--settings=doctorc.settings',
                '--keepdb',
                '--visualRegressionMode=assert',
                testTarget
            ];
            break;
        case 'unit':
        default:
            config.name = 'DrC: Unit Test';
            config.args = [
                'test',
                '--noinput',
                '--exclude-tag=home_service',
                '--settings=doctorc.settings',
                '--keepdb',
                testTarget
            ];
            break;
    }

    return config;
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
