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

async function isWritableDirectory(targetDirectory: string): Promise<boolean> {
    try {
        const stats = await fs.promises.stat(targetDirectory);
        if (!stats.isDirectory()) {
            return false;
        }

        await fs.promises.access(targetDirectory, fs.constants.W_OK);
        return true;
    } catch {
        return false;
    }
}

async function resolveInstallDirectory(homeDirectory: string): Promise<string> {
    const configuredDirectory = process.env.HOST_SCRIPT_INSTALL_DIR?.trim();
    if (configuredDirectory) {
        return configuredDirectory;
    }

    const fallbackDirectory = path.join(homeDirectory, '.local', 'bin');
    const pathEntries = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
    const candidateDirectories = Array.from(new Set(['/usr/local/bin', ...pathEntries]));

    for (const candidateDirectory of candidateDirectories) {
        if (await isWritableDirectory(candidateDirectory)) {
            return candidateDirectory;
        }
    }

    return fallbackDirectory;
}

export async function installHostScriptCli(context: vscode.ExtensionContext): Promise<void> {
    const homeDirectory = os.homedir();
    if (!homeDirectory) {
        return;
    }

    const installDirectory = await resolveInstallDirectory(homeDirectory);
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