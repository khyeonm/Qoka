/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { AriaAuthProvider } from './authProvider';

/**
 * Aria Authentication — registers the `aria` authentication provider (visible in
 * the Accounts menu, bottom-left) plus a status-bar presence: the signed-in
 * user's name + login provider, followed by a Sign out button. These sit
 * between the Aria mode toggle (priority 1000/999) and the Problems item
 * (priority 50), so priorities 200/199 place them just left of Problems.
 *
 * Sign-in uses a localhost loopback redirect (see AriaAuthProvider); no
 * `aria://` UriHandler is needed.
 */

function providerLabel(p: string): string {
	if (p === 'orcid') { return 'ORCID'; }
	if (p === 'google') { return 'Google'; }
	return 'Aria';
}

export function activate(context: vscode.ExtensionContext): void {
	console.log('[aria-authentication] activate()');

	const provider = new AriaAuthProvider(context.secrets);

	// Status-bar items: [ $(account) name (Provider) ] [ Sign out ]
	const accountItem = vscode.window.createStatusBarItem(
		'aria.auth.account', vscode.StatusBarAlignment.Left, 200);
	accountItem.name = 'Aria Account';
	const signOutItem = vscode.window.createStatusBarItem(
		'aria.auth.signout', vscode.StatusBarAlignment.Left, 199);
	signOutItem.name = 'Aria Sign Out';
	signOutItem.text = '$(sign-out) Sign out';
	signOutItem.tooltip = 'Sign out of Aria';
	signOutItem.command = 'aria.auth.signOut';

	const refreshStatus = async () => {
		const info = await provider.currentSession();
		if (info) {
			const name = info.name || info.email || 'Aria user';
			accountItem.text = `$(account) ${name} (${providerLabel(info.provider)})`;
			accountItem.tooltip = 'Signed in to Aria';
			accountItem.show();
			signOutItem.show();
		} else {
			// Signed out — could be a real sign-out OR an expired session mid-work.
			// Keep a visible, clickable "Sign in" cue so the user always knows how
			// to recover (rather than memory silently failing).
			accountItem.text = '$(account) Sign in to Aria';
			accountItem.tooltip = 'Sign in to Aria';
			accountItem.command = 'aria.auth.signIn';
			accountItem.show();
			signOutItem.hide();
		}
	};

	context.subscriptions.push(
		accountItem,
		signOutItem,
		vscode.authentication.registerAuthenticationProvider(
			'aria',
			'Aria',
			provider,
			{ supportsMultipleAccounts: false },
		),
		provider.onDidChangeSessions(() => void refreshStatus()),
		vscode.commands.registerCommand('aria.auth.signIn', async () => {
			await vscode.authentication.getSession('aria', [], { createIfNone: true });
		}),
		vscode.commands.registerCommand('aria.auth.signOut', async () => {
			const sessions = await provider.getSessions();
			for (const s of sessions) {
				await provider.removeSession(s.id);
			}
			// Return to the directory picker on the next sign-in: close the folder
			// so the workbench reloads empty. The login gate then covers it, and
			// after re-login the Aria "Started" overlay shows the picker again.
			// (Setup is NOT re-run — its completion flag persists.)
			await vscode.commands.executeCommand('workbench.action.closeFolder');
		}),
		provider,
	);

	void refreshStatus();

	// Keep the token fresh in the background: getSessions() renews it when it's
	// within REFRESH_SKEW of expiry, so the 7-day access token is renewed long
	// before it lapses and the user (almost) never has to re-sign-in until the
	// 30-day refresh token itself expires.
	const REFRESH_POLL_MS = 6 * 60 * 60 * 1000; // 6h
	const refreshTimer = setInterval(() => {
		void provider.getSessions().then(() => refreshStatus());
	}, REFRESH_POLL_MS);
	context.subscriptions.push({ dispose: () => clearInterval(refreshTimer) });

	// The startup sign-in prompt is handled by the core ariaLoginGate overlay
	// (full-screen gate before the workbench), which drives this provider via
	// IAuthenticationService — so no prompt is raised here.
}

export function deactivate(): void {
	console.log('[aria-authentication] deactivate()');
}
