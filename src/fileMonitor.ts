import * as vscode from 'vscode';

interface FileInfo {
    uri: vscode.Uri;
    openedAt: number;
}

export class PythonFileMonitor {
    private fileOpenTimes: Map<string, number> = new Map();
    private intervalId: NodeJS.Timeout | undefined;
    private disposables: vscode.Disposable[] = [];

    constructor() {}

    public start(): void {
        // Track currently open Python files
        this.initializeOpenFiles();

        // Listen for file open events
        const openListener = vscode.workspace.onDidOpenTextDocument((document) => {
            if (document.languageId === 'python' && document.uri.scheme === 'file') {
                const filePath = document.uri.fsPath;
                if (!this.fileOpenTimes.has(filePath)) {
                    this.fileOpenTimes.set(filePath, Date.now());
                }
            }
        });

        // Listen for file close events
        const closeListener = vscode.workspace.onDidCloseTextDocument((document) => {
            if (document.languageId === 'python' && document.uri.scheme === 'file') {
                const filePath = document.uri.fsPath;
                this.fileOpenTimes.delete(filePath);
            }
        });

        this.disposables.push(openListener, closeListener);

        // Start periodic check
        this.startPeriodicCheck();
    }

    private initializeOpenFiles(): void {
        const now = Date.now();
        vscode.workspace.textDocuments.forEach((document) => {
            if (document.languageId === 'python' && document.uri.scheme === 'file') {
                const filePath = document.uri.fsPath;
                if (!this.fileOpenTimes.has(filePath)) {
                    this.fileOpenTimes.set(filePath, now);
                }
            }
        });
    }

    private startPeriodicCheck(): void {
        const config = vscode.workspace.getConfiguration('pythonCopyQualifiedName.fileMonitor');
        const enabled = config.get<boolean>('enabled', true);
        
        if (!enabled) {
            return;
        }

        const checkIntervalMinutes = config.get<number>('checkInterval', 10);
        const checkIntervalMs = checkIntervalMinutes * 60 * 1000;

        this.intervalId = setInterval(() => {
            this.checkOpenFiles();
        }, checkIntervalMs);
    }

    private async checkOpenFiles(): Promise<void> {
        const config = vscode.workspace.getConfiguration('pythonCopyQualifiedName.fileMonitor');
        const enabled = config.get<boolean>('enabled', true);
        
        if (!enabled) {
            return;
        }

        const maxFiles = config.get<number>('maxFiles', 20);

        // Get currently open Python files
        const openPythonFiles = vscode.workspace.textDocuments.filter(
            (doc) => doc.languageId === 'python' && doc.uri.scheme === 'file'
        );

        const openFileCount = openPythonFiles.length;

        if (openFileCount > maxFiles) {
            const filesToClose = openFileCount - maxFiles;
            await this.showWarningDialog(openFileCount, filesToClose, openPythonFiles);
        }
    }

    private async showWarningDialog(
        totalFiles: number,
        filesToClose: number,
        openPythonFiles: vscode.TextDocument[]
    ): Promise<void> {
        // Sort files by open time (oldest first)
        const fileInfos: FileInfo[] = openPythonFiles.map((doc) => ({
            uri: doc.uri,
            openedAt: this.fileOpenTimes.get(doc.uri.fsPath) || Date.now(),
        }));

        fileInfos.sort((a, b) => a.openedAt - b.openedAt);

        // Get the oldest files to suggest closing
        const oldestFiles = fileInfos.slice(0, filesToClose);

        // Create file list for display
        const fileList = oldestFiles
            .map((file, index) => {
                const workspaceFolder = vscode.workspace.getWorkspaceFolder(file.uri);
                const displayPath = workspaceFolder
                    ? vscode.workspace.asRelativePath(file.uri)
                    : file.uri.fsPath;
                return `  ${index + 1}. ${displayPath}`;
            })
            .join('\n');

        const message = `You have ${totalFiles} Python files open. Consider closing ${filesToClose} file(s):\n\n${fileList}`;

        const closeFilesButton = 'Close These Files';
        const cancelButton = 'Not Now';

        const result = await vscode.window.showWarningMessage(
            message,
            { modal: true },
            closeFilesButton,
            cancelButton
        );

        if (result === closeFilesButton) {
            await this.closeFiles(oldestFiles);
        }
    }

    private async closeFiles(filesToClose: FileInfo[]): Promise<void> {
        for (const fileInfo of filesToClose) {
            // Find the text document
            const document = vscode.workspace.textDocuments.find(
                (doc) => doc.uri.fsPath === fileInfo.uri.fsPath
            );

            if (document) {
                // Find all tabs with this document
                const tabs = vscode.window.tabGroups.all
                    .flatMap((group) => group.tabs)
                    .filter((tab) => {
                        const input = tab.input;
                        return (
                            input instanceof vscode.TabInputText &&
                            input.uri.fsPath === document.uri.fsPath
                        );
                    });

                // Close all tabs with this document
                for (const tab of tabs) {
                    await vscode.window.tabGroups.close(tab);
                }

                // Remove from tracking
                this.fileOpenTimes.delete(document.uri.fsPath);
            }
        }

        vscode.window.showInformationMessage(
            `Closed ${filesToClose.length} Python file(s).`
        );
    }

    public dispose(): void {
        if (this.intervalId) {
            clearInterval(this.intervalId);
        }
        this.disposables.forEach((d) => d.dispose());
    }

    public restartPeriodicCheck(): void {
        if (this.intervalId) {
            clearInterval(this.intervalId);
        }
        this.startPeriodicCheck();
    }
}
