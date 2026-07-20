/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { AriaAiProvider, AriaConcreteProvider } from '../common/ariaConfiguration.js';

/**
 * Shared helpers for the first-run "Choose your AI assistant" step (rendered by
 * the Started overlay) and the startup chat auto-open. Kept UI-free so both a
 * contribution and a plain module can import it without a dependency cycle.
 *
 * Qoka's chat is provided by a Marketplace extension - Claude Code
 * (`anthropic.claude-code`) or Codex (`openai.chatgpt`) - so the picker's job is
 * to let the user choose which one(s) to use and route them to install when a
 * chosen provider isn't present yet.
 */

/** Alias of the canonical provider type (defined in ariaConfiguration) so the
 *  overlay/startup code keeps its familiar name while sharing one source. */
export type ConcreteProvider = AriaConcreteProvider;

/** Marketplace extension identifiers per provider - used both to detect
 *  installation (IExtensionService.getExtension) and to install/open the
 *  extension page (workbench.extensions.installExtension / extension.open). */
export const PROVIDER_EXTENSION_ID: Record<ConcreteProvider, string> = {
	claude: 'anthropic.claude-code',
	codex: 'openai.chatgpt',
};

export const PROVIDER_LABEL: Record<ConcreteProvider, string> = {
	claude: 'Claude Code',
	codex: 'Codex',
};

/** localStorage flag: the user has made their first AI-provider choice. Persisted
 *  so the picker step shows exactly once. */
const PICKED_KEY = 'aria.aiProvider.picked';

export function hasPickedAiProvider(): boolean {
	try {
		return localStorage.getItem(PICKED_KEY) === '1';
	} catch {
		return false;
	}
}

export function markPickedAiProvider(): void {
	try {
		localStorage.setItem(PICKED_KEY, '1');
	} catch {
		// Storage unavailable - the picker may show again next launch; harmless.
	}
}

/** Forget the AI-provider choice so the picker step shows again - called on
 *  sign-out so the next sign-in re-runs the login → AI → project flow. */
export function clearPickedAiProvider(): void {
	try {
		localStorage.removeItem(PICKED_KEY);
	} catch {
		// Storage unavailable - nothing to clear; harmless.
	}
}

/**
 * Map the user's checkbox selection to the single `aria.aiProvider` setting:
 *   - both  → 'auto'  (use whichever, Claude-first)
 *   - claude only → 'claude'
 *   - codex only  → 'codex'
 * `none` shouldn't be reachable (the picker requires ≥1) but falls back to 'auto'.
 */
export function providerSettingFor(claude: boolean, codex: boolean): AriaAiProvider {
	if (claude && codex) { return 'auto'; }
	if (claude) { return 'claude'; }
	if (codex) { return 'codex'; }
	return 'auto';
}

/**
 * Providers the user chose but hasn't installed yet. Recorded when they Continue
 * past the AI picker with a not-yet-installed selection, and consumed once -
 * AFTER a project is opened - to open each one's Marketplace page there (rather
 * than in the empty picker window). Survives the openFolder reload via
 * localStorage.
 */
const PENDING_INSTALL_KEY = 'aria.aiProvider.pendingInstall';

export function setPendingInstall(providers: ConcreteProvider[]): void {
	try {
		if (providers.length === 0) {
			localStorage.removeItem(PENDING_INSTALL_KEY);
		} else {
			localStorage.setItem(PENDING_INSTALL_KEY, JSON.stringify(providers));
		}
	} catch {
		// Storage unavailable - the deferred install just won't auto-open; harmless.
	}
}

/** Read and clear the pending-install list (one-shot). */
export function takePendingInstall(): ConcreteProvider[] {
	let raw: string | null = null;
	try {
		raw = localStorage.getItem(PENDING_INSTALL_KEY);
		localStorage.removeItem(PENDING_INSTALL_KEY);
	} catch {
		return [];
	}
	if (!raw) {
		return [];
	}
	try {
		const arr = JSON.parse(raw);
		return Array.isArray(arr) ? arr.filter((x): x is ConcreteProvider => x === 'claude' || x === 'codex') : [];
	} catch {
		return [];
	}
}
