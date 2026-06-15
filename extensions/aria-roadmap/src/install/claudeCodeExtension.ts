/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

const CLAUDE_CODE_EXTENSION_ID = 'anthropic.claude-code';

export interface InstallResult {
	/** True iff Claude Code is installed at the end of this call (already
	 *  was, or we installed it now). */
	installed: boolean;
	/** True iff this call performed the install. */
	changed: boolean;
	/** Human-readable summary line for the firstRunOverlay toast. */
	summary: string;
}

/**
 * Ensure the Anthropic Claude Code extension is installed.
 *
 * Aria's first launch uses this to bring Claude Code in from the
 * Marketplace so the New Project wizard's chat panel works the moment
 * the user clicks it. We DO NOT vendor the extension — Anthropic
 * publishes it on the Marketplace, redistributing the VSIX with Aria
 * would conflict with Marketplace terms / the extension EULA. The
 * Marketplace install path keeps Aria's distribution clean while
 * still giving the user a one-launch experience.
 *
 * Returns a structured result so the caller (which participates in the
 * firstRunOverlay setup tracking) can format the summary toast.
 */
export async function ensureClaudeCodeInstalled(): Promise<InstallResult> {
	const existing = vscode.extensions.getExtension(CLAUDE_CODE_EXTENSION_ID);
	if (existing) {
		console.log(`[aria-roadmap] Claude Code already installed (version ${existing.packageJSON.version ?? '?'})`);
		return {
			installed: true,
			changed: false,
			summary: 'Claude Code — already installed',
		};
	}

	console.log('[aria-roadmap] Claude Code extension not found; installing from Marketplace…');
	try {
		await vscode.commands.executeCommand(
			'workbench.extensions.installExtension',
			CLAUDE_CODE_EXTENSION_ID,
		);
	} catch (e) {
		const message = (e as Error).message ?? String(e);
		console.error('[aria-roadmap] Claude Code install failed:', message);
		return {
			installed: false,
			changed: false,
			summary: `Claude Code install failed: ${message}`,
		};
	}

	// installExtension resolves before the extension activates; poll until
	// vscode.extensions.getExtension can see it (or we give up).
	const deadline = Date.now() + 30_000;
	while (Date.now() < deadline) {
		if (vscode.extensions.getExtension(CLAUDE_CODE_EXTENSION_ID)) {
			console.log('[aria-roadmap] Claude Code install complete');
			return {
				installed: true,
				changed: true,
				summary: 'Claude Code — installed from Marketplace',
			};
		}
		await new Promise(r => setTimeout(r, 250));
	}
	console.warn('[aria-roadmap] Claude Code install command returned but extension still not visible');
	return {
		installed: false,
		changed: true,
		summary: 'Claude Code — install dispatched, not yet visible (you may need to reload Aria)',
	};
}
