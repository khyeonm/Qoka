/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { spawn } from 'child_process';
import { HeadlessProvider, isProviderInstalled, QOKA_HOME, QOKA_NPM_PREFIX, QOKA_BIN_DIR, QOKA_CODEX_HOME, QOKA_CLAUDE_CONFIG_DIR } from './common/headlessCli';
import { ensureNode } from './common/nodeBootstrap';
import { log } from './common/logger';

/**
 * Install a provider's command-line tool when onboarding picks that AI. The chat
 * panel and Qoka's background features (version summaries, peer review) are
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
 *     download a portable Node first (see nodeBootstrap) and point npm at Qoka's
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

/**
 * Install Claude Code entirely inside Qoka's own tree.
 *
 * The official installer offers no install-dir flag: it downloads a self-
 * contained binary and runs its `install` subcommand, which drops the binary in
 * `$HOME/.local/bin` AND edits the user's shell rc / PATH. We want neither
 * touched. The fix is to run the whole thing with HOME pointed at an isolated
 * sandbox (`~/.qoka/claude-home`): the download, the binary placement, and any rc
 * edits all land inside that sandbox instead of the user's real home. We then
 * copy the resulting binary to `~/.qoka/bin`, the one dir Qoka resolves from. At
 * RUN time the binary uses the real HOME plus CLAUDE_CONFIG_DIR, so nothing about
 * the user's own environment is disturbed.
 */
async function installClaude(): Promise<RunResult> {
	const sandboxHome = path.join(QOKA_HOME, 'claude-home');
	try { fs.mkdirSync(QOKA_BIN_DIR, { recursive: true }); } catch { /* best-effort */ }
	try { fs.mkdirSync(sandboxHome, { recursive: true }); } catch { /* best-effort */ }
	const sandboxEnv = { HOME: sandboxHome, USERPROFILE: sandboxHome, CLAUDE_CONFIG_DIR: QOKA_CLAUDE_CONFIG_DIR };
	const result = isWin
		? await runHidden('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', 'irm https://claude.ai/install.ps1 | iex'], sandboxEnv)
		: await runHidden('/bin/bash', ['-lc', 'curl -fsSL https://claude.ai/install.sh | bash'], sandboxEnv);
	// Lift the installed binary out of the sandbox into ~/.qoka/bin.
	const exe = isWin ? 'claude.exe' : 'claude';
	const candidates = isWin
		? [path.join(sandboxHome, '.local', 'bin', exe), path.join(sandboxHome, 'AppData', 'Local', 'Programs', 'claude', exe)]
		: [path.join(sandboxHome, '.local', 'bin', exe)];
	for (const from of candidates) {
		try {
			if (fs.existsSync(from)) {
				const to = path.join(QOKA_BIN_DIR, exe);
				fs.copyFileSync(from, to);
				if (!isWin) { fs.chmodSync(to, 0o755); }
				break;
			}
		} catch (e) { log(`installClaude: copy ${from} failed - ${(e as Error).message}`); }
	}
	return result;
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
	// ISOLATION: install into Qoka's own npm prefix (~/.qoka/npm), never the system
	// ~/.local or the OS npm global. The codex bin then lands in ~/.qoka/npm/bin
	// (Unix) or the prefix root (Windows), both of which Qoka's resolver probes.
	const prefix = QOKA_NPM_PREFIX;
	// Clear any leftover `.codex-*` temp from a prior interrupted install so npm's
	// atomic-rename doesn't fail with ENOTEMPTY.
	cleanStaleCodexTemp(prefix);
	// CODEX_HOME keeps the config/login under ~/.qoka too, even during install.
	const env: { [key: string]: string } = { npm_config_prefix: prefix, CODEX_HOME: QOKA_CODEX_HOME };
	if (nodeBin) {
		env.PATH = nodeBin + path.delimiter + (process.env.PATH ?? '');
	}
	const npm = isWin ? 'npm.cmd' : 'npm';
	log(`installProviderCli: installing Codex via ${npm} install -g @openai/codex (prefix ${prefix})`);
	const result = await runHidden(npm, ['install', '-g', '@openai/codex'], env);
	// Mirror the codex bin into ~/.qoka/bin so the single resolver dir has it too
	// (Unix bins land in <prefix>/bin; on Windows the .cmd shim sits at the root).
	try {
		fs.mkdirSync(QOKA_BIN_DIR, { recursive: true });
		const names = isWin ? ['codex.cmd', 'codex.exe'] : ['codex'];
		const srcDir = isWin ? prefix : path.join(prefix, 'bin');
		for (const n of names) {
			const from = path.join(srcDir, n);
			if (fs.existsSync(from)) {
				fs.copyFileSync(from, path.join(QOKA_BIN_DIR, n));
				if (!isWin) { fs.chmodSync(path.join(QOKA_BIN_DIR, n), 0o755); }
			}
		}
	} catch (e) { log(`installCodex: mirror to bin failed - ${(e as Error).message}`); }
	return result;
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
				vscode.window.showInformationMessage(`${label} is ready. Reload Qoka if the chat doesn't pick it up.`);
				return;
			}
			log(`installProviderCli: ${provider} CLI install did not complete (exit ${result.code}). Output:\n${result.output}`);
			// Let the session retry on next launch rather than latching failure.
			attemptedThisSession.delete(provider);
			vscode.window.showErrorMessage(`Qoka couldn't install the ${label} command-line tool automatically. See the Qoka Skills log for details.`);
		},
	);
}
