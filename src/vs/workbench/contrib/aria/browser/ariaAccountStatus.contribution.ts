/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { toAction } from '../../../../base/common/actions.js';
import { localize } from '../../../../nls.js';
import { CommandsRegistry, ICommandService } from '../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';
import { AuthenticationSession, IAuthenticationService } from '../../../services/authentication/common/authentication.js';
import { IStatusbarEntryAccessor, IStatusbarService, StatusbarAlignment } from '../../../services/statusbar/browser/statusbar.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { ARIA_MODE_SETTING } from '../common/ariaConfiguration.js';

const AUTH_ID = 'aria';
const SIGN_OUT_COMMAND = 'aria.account.signOut';
const SIGN_IN_COMMAND = 'aria.account.signIn';
const CHANGE_PROJECT_COMMAND = 'aria.account.changeProject';
const ACCOUNT_MENU_COMMAND = 'aria.account.menu';
// Cached display label of the last signed-in account, so easy mode can paint the
// account/Sign out entries instantly on startup instead of waiting for the auth
// extension to activate and restore the session (which is visibly slow on cold start).
const ACCOUNT_CACHE_KEY = 'aria.account.displayCache';

/**
 * The signed-in Qoka account, a Change project button, and a Sign out button
 * (previously only in the launch overlay) live at the bottom-right of the status
 * bar. Shown in BOTH modes: the account item's menu is where AI providers is
 * chosen and Sign out belongs with the account, so they stay on the right in
 * advanced mode too (not just easy).
 */
export class AriaAccountStatusContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.aria.accountStatus';

	private accountEntry: IStatusbarEntryAccessor | undefined;
	private changeProjectEntry: IStatusbarEntryAccessor | undefined;
	private signOutEntry: IStatusbarEntryAccessor | undefined;
	private signInEntry: IStatusbarEntryAccessor | undefined;
	private session: AuthenticationSession | undefined;
	private provider: string | undefined;
	/** False until the first getSessions resolves. Before that we may show the cached
	 *  account to avoid a blank/flip during the restore race; after, a missing session
	 *  is a genuine sign-out and we show "Sign in". */
	private authChecked = false;

	constructor(
		@IStatusbarService private readonly statusbarService: IStatusbarService,
		@IAuthenticationService private readonly authService: IAuthenticationService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@ICommandService private readonly commandService: ICommandService,
		@IStorageService private readonly storageService: IStorageService,
		@IContextMenuService private readonly contextMenuService: IContextMenuService,
		@IWorkspaceContextService private readonly contextService: IWorkspaceContextService,
	) {
		super();

		this._register(CommandsRegistry.registerCommand(SIGN_OUT_COMMAND, () => this.signOut()));
		this._register(CommandsRegistry.registerCommand(SIGN_IN_COMMAND, () => this.signIn()));
		this._register(CommandsRegistry.registerCommand(ACCOUNT_MENU_COMMAND, () => this.showAccountMenu()));
		this._register(CommandsRegistry.registerCommand(CHANGE_PROJECT_COMMAND, () => this.changeProject()));

		// Paint the last-known account immediately (from cache) so easy mode's
		// bottom-right isn't blank while the auth extension activates + restores.
		this.reconcile();
		void this.refresh();
		this._register(this.authService.onDidChangeSessions(e => {
			if (e.providerId === AUTH_ID) {
				void this.refresh();
			}
		}));
		this._register(this.configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(ARIA_MODE_SETTING)) {
				this.reconcile();
			}
		}));
	}

	private async refresh(): Promise<void> {
		try {
			// activateImmediate wakes the aria-authentication extension so its
			// provider is registered before we read sessions.
			const sessions = await this.authService.getSessions(AUTH_ID, undefined, undefined, true);
			this.session = sessions.length > 0 ? sessions[0] : undefined;
		} catch {
			this.session = undefined;
		}
		this.authChecked = true;
		if (this.session) {
			// The session carries no provider (scopes are []); the extension exposes it.
			try {
				const info = await this.commandService.executeCommand<{ provider?: string } | undefined>('aria.auth.getSession');
				this.provider = info?.provider;
			} catch {
				this.provider = undefined;
			}
		}
		this.reconcile();
	}

	private disposeEntries(): void {
		this.accountEntry?.dispose();
		this.accountEntry = undefined;
		this.changeProjectEntry?.dispose();
		this.changeProjectEntry = undefined;
		this.signOutEntry?.dispose();
		this.signOutEntry = undefined;
		this.signInEntry?.dispose();
		this.signInEntry = undefined;
	}

	private cachedLabel(): string | undefined {
		const raw = this.storageService.get(ACCOUNT_CACHE_KEY, StorageScope.APPLICATION);
		if (!raw) {
			return undefined;
		}
		try {
			const label = (JSON.parse(raw) as { label?: string }).label;
			return typeof label === 'string' && label ? label : undefined;
		} catch {
			return undefined;
		}
	}

	/**
	 * Decide what the bottom-right shows from the current mode + session. Favours
	 * the cached account so a slow or racing session restore (e.g. in the freshly
	 * reloaded New Project window) never blanks the bar - only an explicit Sign out
	 * clears it (see signOut).
	 */
	private reconcile(): void {
		// The Qoka account / Change project / Sign out items live at the bottom-right
		// (status bar) in BOTH modes now - advanced mode used to keep the stock bar,
		// but the account menu (where AI providers is chosen) and Sign out belong
		// with the account in every mode, so they sit on the right consistently.
		if (this.session) {
			const name = this.session.account.label || localize('aria.account.fallback', "Qoka user");
			// The provider (google / orcid) comes from the extension (scopes are []).
			const label = this.provider ? `${name} (${this.provider})` : name;
			this.storageService.store(ACCOUNT_CACHE_KEY, JSON.stringify({ label }), StorageScope.APPLICATION, StorageTarget.MACHINE);
			this.paint(label);
			return;
		}
		// No live session. Before the first auth check resolves, keep the last-known
		// account rather than blanking/flipping during the restore race. Once auth IS
		// checked, a missing session is a genuine sign-out: drop the stale cache and
		// show "Sign in" (never a stale account + Sign out).
		const cached = this.cachedLabel();
		if (!this.authChecked && cached) {
			this.paint(cached);
			return;
		}
		if (cached) { this.storageService.remove(ACCOUNT_CACHE_KEY, StorageScope.APPLICATION); }
		this.paintSignedOut();
	}

	/** Signed-out state: "Change project" + "Sign in" at the bottom-right, no account
	 *  label (there is no signed-in user to name). Change project stays because it
	 *  works without a session; Sign in replaces the account + Sign out entries. */
	private paintSignedOut(): void {
		this.disposeEntries();

		this.changeProjectEntry = this.statusbarService.addEntry({
			name: localize('aria.changeProject.name', "Change project"),
			text: localize('aria.changeProject.text', "Change project"),
			ariaLabel: localize('aria.changeProject.ariaLabel', "Change project"),
			tooltip: localize('aria.changeProject.tooltip', "Open a different project"),
			command: CHANGE_PROJECT_COMMAND,
		}, 'aria.switchProject', StatusbarAlignment.RIGHT, 99);

		this.signInEntry = this.statusbarService.addEntry({
			name: localize('aria.signin.name', "Sign in"),
			text: localize('aria.signin.text', "$(account) Sign in"),
			ariaLabel: localize('aria.signin.text', "$(account) Sign in"),
			tooltip: localize('aria.signin.tooltip', "Sign in to Qoka (optional)"),
			command: SIGN_IN_COMMAND,
		}, 'aria.signin', StatusbarAlignment.RIGHT, 98);
	}

	private paint(label: string): void {
		this.disposeEntries();

		this.accountEntry = this.statusbarService.addEntry({
			name: localize('aria.account.name', "Qoka account"),
			text: `$(account) ${label}`,
			ariaLabel: localize('aria.account.ariaLabel', "Signed in as {0}", label),
			tooltip: localize('aria.account.tooltip', "Qoka account - click for AI providers"),
			command: ACCOUNT_MENU_COMMAND,
		}, 'aria.account', StatusbarAlignment.RIGHT, 100);

		// Between the account and Sign out: switch to a different project without
		// signing out. Integer priority between account (100) and Sign out (98) so it
		// sits to their middle (higher priority = further left for right-aligned items).
		this.changeProjectEntry = this.statusbarService.addEntry({
			name: localize('aria.changeProject.name', "Change project"),
			text: localize('aria.changeProject.text', "Change project"),
			ariaLabel: localize('aria.changeProject.ariaLabel', "Change project"),
			tooltip: localize('aria.changeProject.tooltip', "Open a different project (stays signed in)"),
			command: CHANGE_PROJECT_COMMAND,
			// NOTE: fresh entry id (not the earlier 'aria.changeProject') - that id
			// ended up in the persisted `workbench.statusbar.hidden` set during an
			// early buggy build and stayed display:none. A new id is visible by default.
		}, 'aria.switchProject', StatusbarAlignment.RIGHT, 99);

		this.signOutEntry = this.statusbarService.addEntry({
			name: localize('aria.signout.name', "Sign out"),
			text: localize('aria.signout.text', "Sign out"),
			ariaLabel: localize('aria.signout.text', "Sign out"),
			tooltip: localize('aria.signout.tooltip', "Sign out of Qoka"),
			command: SIGN_OUT_COMMAND,
		}, 'aria.signout', StatusbarAlignment.RIGHT, 98);
	}

	private async changeProject(): Promise<void> {
		// Close the folder WITHOUT signing out. The window reloads into an empty
		// workbench where the Started overlay - since a session and an AI-provider
		// choice already exist - skips login and the AI picker and shows the
		// project picker directly, so the user can open/create another project.
		//
		// Mark this as an EXPLICIT picker request (localStorage key mirrors
		// WANT_PICKER_FLAG in ariaStartedOverlay). Without it the overlay would
		// auto-reopen the project we're leaving instead of showing the picker.
		// localStorage survives the closeFolder reload; the overlay consumes it once.
		try { localStorage.setItem('aria.started.wantPicker', '1'); } catch { /* ignore */ }
		try {
			await this.commandService.executeCommand('workbench.action.closeFolder');
		} catch {
			// ignore - e.g. already an empty workbench.
		}
	}

	/** Clicking the account item opens a small menu ABOVE it. Currently: choose
	 *  which AI(s) Qoka uses (Claude / Codex). */
	private showAccountMenu(): void {
		const anchor = mainWindow.document.getElementById('status.aria.account')
			?? (mainWindow.document.querySelector('.part.statusbar .right-items') as HTMLElement | null)
			?? undefined;
		this.contextMenuService.showContextMenu({
			getAnchor: () => anchor ?? { x: 0, y: 0 },
			getActions: () => [
				toAction({
					id: 'aria.aiProvider.choose',
					label: localize('aria.aiProviders.menu', "AI providers"),
					run: () => { void this.commandService.executeCommand('aria.aiProvider.choose'); },
				}),
			],
		});
	}

	/** Sign in from within a project (Settings / status bar). Returns to the initial
	 *  login screen (with its guidance copy) rather than an inline popup: remember the
	 *  current project so we can reopen it after login, drop any "skipped" guest flag
	 *  so the login screen shows, then close the folder -> empty workbench -> the
	 *  Started overlay shows login. After a successful login the overlay reopens the
	 *  remembered project (see SIGNIN_RETURN_TO in ariaStartedOverlay). */
	private async signIn(): Promise<void> {
		console.log('[aria] sign in triggered');
		try {
			const folder = this.contextService.getWorkspace().folders[0];
			if (folder) {
				localStorage.setItem('aria.signin.returnTo', folder.uri.toString());
			}
		} catch { /* ignore - no folder to remember */ }
		try { localStorage.removeItem('aria.login.skipped'); } catch { /* ignore */ }
		try {
			await this.commandService.executeCommand('workbench.action.closeFolder');
		} catch {
			// Already an empty workbench: the overlay's login screen is (or will be) up.
		}
	}

	private async signOut(): Promise<void> {
		console.log('[aria] sign out triggered');
		// Sign-in is optional, so signing out KEEPS the project open (no folder close).
		// Remove the session, clear the cached account, and repaint to the signed-out
		// "Sign in" entry. Features needing the server identity gate themselves.
		try {
			const sessions = await this.authService.getSessions(AUTH_ID, undefined, undefined, true);
			for (const s of sessions) {
				try { await this.authService.removeSession(AUTH_ID, s.id); } catch { /* ignore */ }
			}
		} catch { /* ignore - best-effort */ }
		this.session = undefined;
		this.storageService.remove(ACCOUNT_CACHE_KEY, StorageScope.APPLICATION);
		this.reconcile();
		return;
	}

}
