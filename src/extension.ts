import * as vscode from 'vscode';
import * as path from 'path';

export function activate(context: vscode.ExtensionContext) {
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

    const relativePath = path.relative(workspaceFolder.uri.fsPath, uri.fsPath);
    const modulePath = relativePath
        .replace(/\\/g, '/') // Convert Windows paths
        .replace(/\.py$/, '') // Remove .py extension
        .replace(/\//g, '.'); // Convert to dot notation

    return modulePath;
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
