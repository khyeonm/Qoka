/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

/**
 * In Easy Mode the workbench remaps `--vscode-button-background` to the Qoka
 * accent (see `ariaEasyMode.css` `--aria-accent`), so native buttons render in
 * the sky-blue brand colour. That override lives on the workbench root and does
 * NOT reach webview iframes, so a webview's `var(--vscode-button-background)`
 * falls back to the theme's deep blue and clashes with the native buttons.
 *
 * Emit a `:root` block that re-applies the same remap inside the webview, so
 * every webview button that uses `var(--vscode-button-background)` matches the
 * native ones (e.g. the Autopipe section's "Connect to GitHub"). Advanced Mode
 * uses the theme's button colour in both places, so emit nothing there.
 *
 * Keep the two hex values in sync with `--aria-accent` / `--aria-accent-hover`
 * in `ariaEasyMode.css`.
 */
export function qokaWebviewAccentCss(): string {
	const advanced = vscode.workspace.getConfiguration().get<string>('aria.mode') === 'advanced';
	if (advanced) { return ''; }
	return ':root { --vscode-button-background: #2ba7c9; --vscode-button-hoverBackground: #2496b6; }';
}
