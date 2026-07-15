/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { exec } from 'child_process';
import { promisify } from 'util';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

const execAsync = promisify(exec);

export const CLAUDE_CODE_EXTENSION_ID = 'anthropic.claude-code';
export const CODEX_EXTENSION_ID = 'openai.chatgpt';

export type AiProviderKind = 'claude-code' | 'codex';

export interface DetectedProvider {
	kind: AiProviderKind;
	displayName: string;
	extensionId: string;
	installed: boolean;
	active: boolean;
}

export interface AiDetection {
	providers: DetectedProvider[];
	/** True iff at least one supported AI assistant is installed. */
	anyInstalled: boolean;
	/** Claude CLI presence (kept for internal MCP registration; not shown to users). */
	claudeCliInstalled: boolean;
	claudeCliVersion: string | null;
}

/**
 * Common shell-installed locations the Claude CLI lands in. The desktop
 * launcher inherits a minimal PATH that often misses these. Probed before
 * falling back to whatever's on the inherited PATH.
 */
export function candidateClaudePaths(): string[] {
	return candidateBinaryPaths('claude', ['.claude/local/claude']);
}

/** Candidate locations for the Codex CLI. Mirrors `candidateClaudePaths`
 *  but probes the Codex install spots - the extension typically installs
 *  codex via the same nvm-managed node, so the candidate set is similar. */
export function candidateCodexPaths(): string[] {
	return candidateBinaryPaths('codex');
}

/** Shared probe for CLI binaries that may live in nvm-managed node bins,
 *  Homebrew, /usr/local, or ~/.local/bin. `extraHomeRelative` lets a
 *  particular CLI add tool-specific install paths inside the home dir
 *  (Claude has `.claude/local/<name>`). */
function candidateBinaryPaths(name: string, extraHomeRelative: string[] = []): string[] {
	const home = os.homedir();
	const out: string[] = [];
	const direct = [
		`/usr/local/bin/${name}`,
		`/opt/homebrew/bin/${name}`,
		path.join(home, '.local/bin', name),
		path.join(home, 'bin', name),
		...extraHomeRelative.map(rel => path.join(home, rel)),
		// Windows: npm installs the CLI as a `.cmd` shim under the npm prefix root
		// (Aria-managed ~/.aria/npm or the OS default %APPDATA%/npm), none of which
		// sit on the GUI process PATH.
		...(process.platform === 'win32' ? [
			path.join(home, '.aria', 'npm', `${name}.cmd`),
			path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'npm', `${name}.cmd`),
			path.join(home, '.local', 'bin', `${name}.exe`),
		] : []),
	];
	for (const p of direct) {
		if (fs.existsSync(p)) {
			out.push(p);
		}
	}
	const nvm = path.join(home, '.nvm/versions/node');
	if (fs.existsSync(nvm)) {
		try {
			for (const ver of fs.readdirSync(nvm)) {
				const p = path.join(nvm, ver, 'bin', name);
				if (fs.existsSync(p)) {
					out.push(p);
				}
			}
		} catch {
			// ignore
		}
	}
	return out;
}

async function tryClaudeVersion(binary: string): Promise<string | null> {
	try {
		const { stdout } = await execAsync(`"${binary}" --version`, { timeout: 5000 });
		return stdout.trim();
	} catch {
		return null;
	}
}

/**
 * Detect installed AI assistants - currently Claude Code and Codex. We also
 * probe for the Claude CLI on disk because MCP registration uses
 * `claude mcp add`; the CLI presence is part of the detection payload
 * (consumed only by the registration code path, not surfaced in UI).
 */
export async function detectAiProviders(): Promise<AiDetection> {
	const providers: DetectedProvider[] = [];

	const claudeExt = vscode.extensions.getExtension(CLAUDE_CODE_EXTENSION_ID);
	providers.push({
		kind: 'claude-code',
		displayName: 'Claude Code',
		extensionId: CLAUDE_CODE_EXTENSION_ID,
		installed: !!claudeExt,
		active: claudeExt?.isActive ?? false,
	});

	const codexExt = vscode.extensions.getExtension(CODEX_EXTENSION_ID);
	providers.push({
		kind: 'codex',
		displayName: 'Codex',
		extensionId: CODEX_EXTENSION_ID,
		installed: !!codexExt,
		active: codexExt?.isActive ?? false,
	});

	// Claude CLI probe - internal use only.
	let cliVersion: string | null = await tryClaudeVersion('claude');
	if (!cliVersion) {
		for (const candidate of candidateClaudePaths()) {
			cliVersion = await tryClaudeVersion(candidate);
			if (cliVersion) {
				break;
			}
		}
	}

	return {
		providers,
		anyInstalled: providers.some(p => p.installed),
		claudeCliInstalled: !!cliVersion,
		claudeCliVersion: cliVersion,
	};
}
