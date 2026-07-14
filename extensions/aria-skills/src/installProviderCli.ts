/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as path from 'path';
import { HeadlessProvider, isProviderInstalled, ARIA_NPM_PREFIX } from './common/headlessCli';
import { ensureNode } from './common/nodeBootstrap';
import { log } from './common/logger';

/**
 * Install a provider's command-line tool when onboarding picks that AI. The chat
 * panel and Aria's background features (version summaries, peer review) are
 * CLI-backed, so choosing a provider means its CLI must exist — not just its VS
 * Code extension.
 *
 * We install AUTOMATICALLY (no confirm), in a VISIBLE integrated terminal so the
 * user sees progress/errors and the terminal inherits the user's full login-shell
 * PATH (so `curl`/`npm` resolve there even when the GUI app's PATH is truncated).
 *
 * Cross-platform, so a non-developer never installs anything by hand:
 *   - Claude ships a self-contained binary — `install.sh` on Unix, the native
 *     PowerShell installer on Windows (neither needs Node).
 *   - Codex is an npm package, so it needs Node. When the machine has none we
 *     download a portable Node first (see nodeBootstrap) and point npm at Aria's
 *     own prefix, which headlessCli also probes.
 *
 * The "already attempted" guard is per-SESSION (in-memory), so it never nags
 * twice within one run but always re-tries on a fresh launch — which is exactly
 * what you want while testing (delete the CLI, relaunch, it re-installs).
 */

const isWin = process.platform === 'win32';
const attemptedThisSession = new Set<HeadlessProvider>();

function toProvider(arg: unknown): HeadlessProvider | undefined {
	return arg === 'claude' || arg === 'codex' ? arg : undefined;
}

/** Open a visible terminal (optionally with extra env) and run one command. */
function runInTerminal(name: string, command: string, env?: { [key: string]: string | null }): void {
	const term = vscode.window.createTerminal({ name, env });
	term.show();
	term.sendText(command, true);
}

function installClaude(): void {
	const command = isWin
		? 'powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://claude.ai/install.ps1 | iex"'
		: 'curl -fsSL https://claude.ai/install.sh | bash';
	log(`installProviderCli: installing Claude via: ${command}`);
	runInTerminal('Aria — Install Claude CLI', command);
	vscode.window.showInformationMessage('Installing the Claude command-line tool… (running in the terminal)');
}

async function installCodex(): Promise<void> {
	// Codex is an npm package → it needs Node to install and to run. Provision a
	// portable Node when the machine has none so the user installs nothing.
	let nodeBin = '';
	try {
		nodeBin = await vscode.window.withProgress(
			{ location: vscode.ProgressLocation.Notification, title: 'Preparing to install Codex…' },
			() => ensureNode(),
		);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		log(`installProviderCli: ensureNode failed — ${message}`);
		vscode.window.showErrorMessage(`Aria couldn't set up Node for Codex: ${message}`);
		return;
	}
	// Install into Aria's own npm prefix so the codex bin lands where headlessCli
	// looks, regardless of whether the machine had its own Node.
	const env: { [key: string]: string | null } = { npm_config_prefix: ARIA_NPM_PREFIX };
	if (nodeBin) {
		env.PATH = nodeBin + path.delimiter + (process.env.PATH ?? '');
	}
	const npm = isWin ? 'npm.cmd' : 'npm';
	const command = `${npm} install -g @openai/codex`;
	log(`installProviderCli: installing Codex via: ${command} (prefix ${ARIA_NPM_PREFIX})`);
	runInTerminal('Aria — Install Codex CLI', command, env);
	vscode.window.showInformationMessage('Installing the Codex command-line tool… (running in the terminal)');
}

/**
 * Ensure the given provider's CLI is installed. No-ops when the argument isn't a
 * known provider or the CLI is already present. Otherwise auto-installs it (in a
 * visible terminal), at most once per session.
 */
export async function installProviderCli(arg: unknown): Promise<void> {
	const provider = toProvider(arg);
	if (!provider) {
		log(`installProviderCli: ignoring non-provider arg ${JSON.stringify(arg)}`);
		return;
	}
	if (isProviderInstalled(provider)) {
		log(`installProviderCli: ${provider} CLI already installed — nothing to do.`);
		return;
	}
	if (attemptedThisSession.has(provider)) {
		log(`installProviderCli: ${provider} CLI install already attempted this session — skipping.`);
		return;
	}
	attemptedThisSession.add(provider);
	if (provider === 'claude') {
		installClaude();
	} else {
		await installCodex();
	}
}
