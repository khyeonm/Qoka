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
	/** The provider's VS Code chat EXTENSION is installed. */
	installed: boolean;
	/** The provider's CLI is installed on disk (what reviews / run_code actually
	 *  execute - `claude --print` / `codex exec`). Independent of the extension. */
	cliInstalled: boolean;
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
function candidateBinaryPaths(name: string, _extraHomeRelative: string[] = []): string[] {
	// ISOLATION: Qoka installs the CLIs under ~/.qoka and runs only that copy - never
	// a system claude/codex on PATH, Homebrew, ~/.local/bin or nvm (which would carry
	// a separate login). Claude lands in ~/.qoka/bin; Codex is an npm global, so it
	// lands in ~/.qoka/npm/bin. Probe both.
	const home = os.homedir();
	const qokaBin = path.join(home, '.qoka', 'bin');
	const qokaNpmBin = path.join(home, '.qoka', 'npm', 'bin');
	const direct = process.platform === 'win32'
		? [path.join(qokaBin, `${name}.cmd`), path.join(qokaBin, `${name}.exe`), path.join(qokaNpmBin, `${name}.cmd`), path.join(qokaNpmBin, `${name}.exe`)]
		: [path.join(qokaBin, name), path.join(qokaNpmBin, name)];
	return direct.filter(p => {
		try { return fs.existsSync(p); } catch { return false; }
	});
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
	const claudeExt = vscode.extensions.getExtension(CLAUDE_CODE_EXTENSION_ID);
	const codexExt = vscode.extensions.getExtension(CODEX_EXTENSION_ID);

	// CLI presence - what reviews / run_code actually execute, independent of the
	// VS Code chat extension. Claude gets a version probe (also confirms it runs);
	// Codex is detected by its binary on disk (fast, no auth needed).
	let cliVersion: string | null = await tryClaudeVersion('claude');
	if (!cliVersion) {
		for (const candidate of candidateClaudePaths()) {
			cliVersion = await tryClaudeVersion(candidate);
			if (cliVersion) {
				break;
			}
		}
	}
	const claudeCliInstalled = !!cliVersion || candidateClaudePaths().length > 0;
	const codexCliInstalled = candidateCodexPaths().length > 0;

	const providers: DetectedProvider[] = [
		{
			kind: 'claude-code',
			displayName: 'Claude Code',
			extensionId: CLAUDE_CODE_EXTENSION_ID,
			installed: !!claudeExt,
			cliInstalled: claudeCliInstalled,
			active: claudeExt?.isActive ?? false,
		},
		{
			kind: 'codex',
			displayName: 'Codex',
			extensionId: CODEX_EXTENSION_ID,
			installed: !!codexExt,
			cliInstalled: codexCliInstalled,
			active: codexExt?.isActive ?? false,
		},
	];

	return {
		providers,
		anyInstalled: providers.some(p => p.installed),
		claudeCliInstalled,
		claudeCliVersion: cliVersion,
	};
}
