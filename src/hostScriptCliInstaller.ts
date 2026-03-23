import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

const CLI_NAME = 'host-script';

function shellEscape(value: string): string {
    return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function isPathDirectoryListed(targetDirectory: string): boolean {
    const pathEntries = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
    return pathEntries.includes(targetDirectory);
}

export async function installHostScriptCli(context: vscode.ExtensionContext): Promise<void> {
    const homeDirectory = os.homedir();
    if (!homeDirectory) {
        return;
    }

    const installDirectory = process.env.HOST_SCRIPT_INSTALL_DIR?.trim() || path.join(homeDirectory, '.local', 'bin');
    const cliEntryPath = path.join(context.extensionPath, 'out', 'hostScriptCli.js');
    const wrapperPath = path.join(installDirectory, CLI_NAME);
    const wrapperContent = [
        '#!/usr/bin/env bash',
        'set -euo pipefail',
        `exec ${shellEscape(process.execPath)} ${shellEscape(cliEntryPath)} "$@"`
    ].join('\n') + '\n';

    try {
        await fs.promises.mkdir(installDirectory, { recursive: true });
        const currentContent = await fs.promises.readFile(wrapperPath, 'utf8').catch(() => '');
        if (currentContent !== wrapperContent) {
            await fs.promises.writeFile(wrapperPath, wrapperContent, { mode: 0o755 });
        }
        await fs.promises.chmod(wrapperPath, 0o755);

        if (!isPathDirectoryListed(installDirectory)) {
            console.warn(
                `[host-script] Installed ${wrapperPath}, but ${installDirectory} is not in PATH for the current extension host process.`
            );
        }
    } catch (error) {
        console.warn(`[host-script] Failed to install CLI: ${String(error)}`);
    }
}