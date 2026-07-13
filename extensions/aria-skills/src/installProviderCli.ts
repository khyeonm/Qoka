/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { HeadlessProvider, isProviderInstalled } from './common/headlessCli';
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
 * The "already attempted" guard is per-SESSION (in-memory), so it never nags
 * twice within one run but always re-tries on a fresh launch — which is exactly
 * what you want while testing (delete the CLI, relaunch, it re-installs).
 */

interface InstallSpec {
	label: string;
	/** Command run in the integrated terminal. */
	command: string;
}

const INSTALL: Record<HeadlessProvider, InstallSpec> = {
	claude: {
		label: 'Claude',
		// Native installer — no npm/Node required; installs a self-contained
		// binary into ~/.local/bin (one of the paths headlessCli probes).
		command: 'curl -fsSL https://claude.ai/install.sh | bash',
	},
	codex: {
		label: 'Codex',
		// Codex ships as an npm package. The integrated terminal has the user's
		// full shell PATH, so npm/node resolve there even when the app's don't.
		command: 'npm install -g @openai/codex',
	},
};

const attemptedThisSession = new Set<HeadlessProvider>();

function toProvider(arg: unknown): HeadlessProvider | undefined {
	return arg === 'claude' || arg === 'codex' ? arg : undefined;
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
	const spec = INSTALL[provider];
	log(`installProviderCli: ${provider} CLI missing — opening a terminal to run: ${spec.command}`);
	const term = vscode.window.createTerminal(`Aria — Install ${spec.label} CLI`);
	term.show();
	term.sendText(spec.command, true);
	vscode.window.showInformationMessage(`Installing the ${spec.label} command-line tool… (running in the terminal)`);
}
