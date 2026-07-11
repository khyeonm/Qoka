/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { timeout } from '../../../../base/common/async.js';
import { ARIA_AI_PROVIDER_SETTING, AriaAiProvider } from '../common/ariaConfiguration.js';

/** Reveal commands per provider, best (secondary/aux-bar view) first. */
const REVEAL_COMMANDS: Record<Exclude<AriaAiProvider, 'auto'>, string[]> = {
	claude: ['claudeVSCodeSidebarSecondary.focus', 'claude-vscode.sidebar.open'],
	codex: ['chatgpt.sidebarSecondaryView.focus', 'chatgpt.openSidebar'],
};

/**
 * Reveal whichever AI provider chat the user has installed — Claude Code
 * or Codex. Aria does NOT own the chat UI: each provider is a
 * separate VS Code extension contributing its own sidebar view, so we can't
 * open "the Aria chat". Instead we focus the auxiliary bar and then try each
 * provider's reveal command in turn. Only the installed provider's command is
 * registered, so unknown commands throw and are skipped; the first that
 * resolves wins.
 *
 * When several providers are installed, the `aria.aiProvider` setting decides
 * which one to reveal first (default `auto` = Claude-first). Fire-and-forget:
 * every failure is non-fatal (the provider simply isn't installed / ready).
 */
export async function revealAiProviderChat(
	commandService: ICommandService,
	configurationService: IConfigurationService,
	opts?: { retryMs?: number },
): Promise<void> {
	const preferred = configurationService.getValue<AriaAiProvider>(ARIA_AI_PROVIDER_SETTING) ?? 'auto';
	const base: Array<Exclude<AriaAiProvider, 'auto'>> = ['claude', 'codex'];
	const order: Array<Exclude<AriaAiProvider, 'auto'>> = preferred === 'auto'
		? base
		: [preferred, ...base.filter(p => p !== preferred)];

	// A just-installed provider extension may not have registered its reveal
	// command yet. When a retry window is given (e.g. right after install), keep
	// trying until one succeeds or the window elapses; ✨-button callers pass no
	// window and get the original single-attempt behaviour.
	const deadline = opts?.retryMs ? Date.now() + opts.retryMs : 0;
	do {
		try {
			await commandService.executeCommand('workbench.action.focusAuxiliaryBar');
		} catch { /* aux bar may already be open */ }

		for (const provider of order) {
			for (const command of REVEAL_COMMANDS[provider]) {
				try {
					await commandService.executeCommand(command);
					return; // revealed
				} catch { /* not this provider / not ready — try the next */ }
			}
		}
		if (deadline) {
			await timeout(400);
		}
	} while (deadline && Date.now() < deadline);
}
