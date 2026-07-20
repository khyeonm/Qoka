/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { AriaAuthProvider } from './authProvider';

/**
 * Qoka Authentication - registers the `aria` authentication provider (visible in
 * the Accounts menu, bottom-left) plus a status-bar presence: the signed-in
 * user's name + login provider, followed by a Sign out button. These sit
 * between the Qoka mode toggle (priority 1000/999) and the Problems item
 * (priority 50), so priorities 200/199 place them just left of Problems.
 *
 * Sign-in uses a localhost loopback redirect (see AriaAuthProvider); no
 * `aria://` UriHandler is needed.
 */

export function activate(context: vscode.ExtensionContext): void {
	console.log('[aria-authentication] activate()');

	const provider = new AriaAuthProvider(context.secrets);

	// The signed-in account, Change project, and Sign out UI is owned entirely by
	// the workbench's AriaAccountStatusContribution (bottom-right, BOTH modes). This
	// extension used to add its OWN account + Sign out items on the LEFT in advanced
	// mode, which duplicated the workbench's (two "signed in as" items, one left one
	// right). We no longer create any status-bar items here.

	context.subscriptions.push(
		vscode.authentication.registerAuthenticationProvider(
			'aria',
			'Qoka',
			provider,
			{ supportsMultipleAccounts: false },
		),
		vscode.commands.registerCommand('aria.auth.signIn', async () => {
			await vscode.authentication.getSession('aria', [], { createIfNone: true });
		}),
		// Abort an in-flight browser sign-in (the Started overlay's "Back to
		// sign-in" calls this). Without it a closed browser leaves the loopback
		// login pending, blocking a subsequent sign-in with another provider.
		vscode.commands.registerCommand('aria.auth.cancelSignIn', () => {
			provider.cancelActiveLogin();
		}),
		// Exposes the signed-in {name, email, provider} to the workbench UI (the
		// Started overlay + the easy-mode account status item), since the standard
		// AuthenticationSession carries no provider (scopes are []).
		vscode.commands.registerCommand('aria.auth.getSession', async () => {
			return provider.currentSession();
		}),
		vscode.commands.registerCommand('aria.auth.signOut', async () => {
			const sessions = await provider.getSessions();
			for (const s of sessions) {
				await provider.removeSession(s.id);
			}
			// Return to the directory picker on the next sign-in: close the folder
			// so the workbench reloads empty. The login gate then covers it, and
			// after re-login the Qoka "Started" overlay shows the picker again.
			// (Setup is NOT re-run - its completion flag persists.)
			await vscode.commands.executeCommand('workbench.action.closeFolder');
		}),
		provider,
	);

	// Keep the token fresh in the background: getSessions() renews it when it's
	// within REFRESH_SKEW of expiry, so the 7-day access token is renewed long
	// before it lapses and the user (almost) never has to re-sign-in until the
	// 30-day refresh token itself expires.
	const REFRESH_POLL_MS = 6 * 60 * 60 * 1000; // 6h
	const refreshTimer = setInterval(() => {
		// getSessions() renews the token when near expiry; that's the only reason to
		// poll (the account UI is workbench-owned and updates via authService events).
		void provider.getSessions();
	}, REFRESH_POLL_MS);
	context.subscriptions.push({ dispose: () => clearInterval(refreshTimer) });

	// The startup sign-in prompt is handled by the core ariaLoginGate overlay
	// (full-screen gate before the workbench), which drives this provider via
	// IAuthenticationService - so no prompt is raised here.
}

export function deactivate(): void {
	console.log('[aria-authentication] deactivate()');
}
