/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { spawn } from 'child_process';
import { HeadlessProvider, isProviderInstalled, ARIA_NPM_PREFIX } from './common/headlessCli';
import { ensureNode } from './common/nodeBootstrap';
import { log } from './common/logger';

/**
 * Install a provider's command-line tool when onboarding picks that AI. The chat
 * panel and Aria's background features (version summaries, peer review) are
 * CLI-backed, so choosing a provider means its CLI must exist - not just its VS
 * Code extension.
 *
 * We install AUTOMATICALLY (no confirm) in a HIDDEN background process - never a
 * visible terminal (which would pop the panel open, flash a console window on
 * Windows, and give no completion signal so the UI could never say "done"). A
 * progress notification shows it's working; on Windows every child is spawned
 * with `windowsHide` so no console flashes.
 *
 * Cross-platform, so a non-developer never installs anything by hand:
 *   - Claude ships a self-contained binary - `install.sh` on Unix (run through a
 *     login shell so `curl` and the install dir resolve), the native PowerShell
 *     installer on Windows. Neither needs Node.
 *   - Codex is an npm package, so it needs Node. When the machine has none we
 *     download a portable Node first (see nodeBootstrap) and point npm at Aria's
 *     own prefix, which headlessCli also probes.
 *
 * The "already attempted" guard is per-SESSION (in-memory), so it never nags
 * twice within one run but always re-tries on a fresh launch - which is exactly
 * what you want while testing (delete the CLI, relaunch, it re-installs).
 */

const isWin = process.platform === 'win32';
const attemptedThisSession = new Set<HeadlessProvider>();

function toProvider(arg: unknown): HeadlessProvider | undefined {
	return arg === 'claude' || arg === 'codex' ? arg : undefined;
}

interface RunResult { code: number; output: string; }

/** Run a command to completion as a hidden background process, collecting its
 *  combined output. Never opens a terminal or flashes a console window. */
function runHidden(command: string, args: string[], extraEnv?: { [key: string]: string }): Promise<RunResult> {
	return new Promise((resolve) => {
		const env = { ...process.env, ...extraEnv };
		// `.cmd` shims (npm.cmd) need a shell on Windows; real executables
		// (powershell, bash) don't. windowsHide keeps any console off-screen.
		const useShell = isWin && command.toLowerCase().endsWith('.cmd');
		const child = spawn(command, args, { env, windowsHide: true, shell: useShell, stdio: ['ignore', 'pipe', 'pipe'] });
		let output = '';
		child.stdout?.on('data', (d) => { output += d.toString(); });
		child.stderr?.on('data', (d) => { output += d.toString(); });
		child.on('error', (err) => { output += `\n${err.message}`; resolve({ code: -1, output }); });
		child.on('close', (code) => resolve({ code: code ?? -1, output }));
	});
}

async function installClaude(): Promise<RunResult> {
	if (isWin) {
		return runHidden('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', 'irm https://claude.ai/install.ps1 | iex']);
	}
	// Login shell (-lc) so the user's full PATH (curl, install target dir) resolves
	// even when the GUI app inherited a truncated PATH.
	return runHidden('/bin/bash', ['-lc', 'curl -fsSL https://claude.ai/install.sh | bash']);
}

/**
 * `npm install -g` replaces a package atomically: it renames the existing
 * `@openai/codex` aside to a `@openai/.codex-<rand>` temp dir before extracting
 * the new one. A leftover `.codex-*` temp from a PRIOR interrupted install makes
 * that rename fail with `ENOTEMPTY: directory not empty`, so every retry then
 * fails the same way. Delete those stale temps first so the install self-heals.
 */
function cleanStaleCodexTemp(prefix: string): void {
	const openaiDir = isWin
		? path.join(prefix, 'node_modules', '@openai')
		: path.join(prefix, 'lib', 'node_modules', '@openai');
	try {
		for (const name of fs.readdirSync(openaiDir)) {
			if (name.startsWith('.codex-')) {
				try { fs.rmSync(path.join(openaiDir, name), { recursive: true, force: true }); } catch { /* best-effort */ }
			}
		}
	} catch { /* no @openai dir yet - nothing to clean */ }
}

async function installCodex(): Promise<RunResult> {
	// Codex is an npm package → it needs Node to install and to run. Provision a
	// portable Node when the machine has none so the user installs nothing.
	let nodeBin = '';
	try {
		nodeBin = await ensureNode();
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		log(`installProviderCli: ensureNode failed - ${message}`);
		return { code: -1, output: `Couldn't set up Node for Codex: ${message}` };
	}
	// Install into ~/.local on Unix so the codex bin lands in ~/.local/bin - a
	// directory EVERY Aria extension's resolver already probes (peer-review
	// availability, MCP registration), not just aria-skills' headlessCli. On
	// Windows keep Aria's own prefix (those resolvers are Windows-agnostic).
	const prefix = isWin ? ARIA_NPM_PREFIX : path.join(os.homedir(), '.local');
	// Clear any leftover `.codex-*` temp from a prior interrupted install so npm's
	// atomic-rename doesn't fail with ENOTEMPTY.
	cleanStaleCodexTemp(prefix);
	const env: { [key: string]: string } = { npm_config_prefix: prefix };
	if (nodeBin) {
		env.PATH = nodeBin + path.delimiter + (process.env.PATH ?? '');
	}
	const npm = isWin ? 'npm.cmd' : 'npm';
	log(`installProviderCli: installing Codex via ${npm} install -g @openai/codex (prefix ${prefix})`);
	return runHidden(npm, ['install', '-g', '@openai/codex'], env);
}

/**
 * Ensure the given provider's CLI is installed. No-ops when the argument isn't a
 * known provider or the CLI is already present. Otherwise auto-installs it in a
 * hidden background process (with a progress notification), at most once per
 * session, and reports success/failure when it finishes.
 */
export async function installProviderCli(arg: unknown): Promise<void> {
	const provider = toProvider(arg);
	if (!provider) {
		log(`installProviderCli: ignoring non-provider arg ${JSON.stringify(arg)}`);
		return;
	}
	if (isProviderInstalled(provider)) {
		log(`installProviderCli: ${provider} CLI already installed - nothing to do.`);
		return;
	}
	if (attemptedThisSession.has(provider)) {
		log(`installProviderCli: ${provider} CLI install already attempted this session - skipping.`);
		return;
	}
	attemptedThisSession.add(provider);

	const label = provider === 'claude' ? 'Claude' : 'Codex';
	await vscode.window.withProgress(
		{ location: vscode.ProgressLocation.Notification, title: `Installing the ${label} command-line tool…`, cancellable: false },
		async () => {
			const result = provider === 'claude' ? await installClaude() : await installCodex();
			// Trust the resolver, not the exit code: some installers return non-zero
			// yet still place the binary (and vice versa). If it's now on PATH, we're
			// done regardless.
			if (isProviderInstalled(provider)) {
				log(`installProviderCli: ${provider} CLI installed successfully.`);
				vscode.window.showInformationMessage(`${label} is ready. Reload Aria if the chat doesn't pick it up.`);
				return;
			}
			log(`installProviderCli: ${provider} CLI install did not complete (exit ${result.code}). Output:\n${result.output}`);
			// Let the session retry on next launch rather than latching failure.
			attemptedThisSession.delete(provider);
			vscode.window.showErrorMessage(`Aria couldn't install the ${label} command-line tool automatically. See the Aria Skills log for details.`);
		},
	);
}
