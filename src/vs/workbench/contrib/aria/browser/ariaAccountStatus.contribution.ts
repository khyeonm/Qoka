/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { CommandsRegistry, ICommandService } from '../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';
import { AuthenticationSession, IAuthenticationService } from '../../../services/authentication/common/authentication.js';
import { IStatusbarEntryAccessor, IStatusbarService, StatusbarAlignment } from '../../../services/statusbar/browser/statusbar.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { ARIA_MODE_SETTING } from '../common/ariaConfiguration.js';

const AUTH_ID = 'aria';
const SIGN_OUT_COMMAND = 'aria.account.signOut';
const CHANGE_PROJECT_COMMAND = 'aria.account.changeProject';
// Cached display label of the last signed-in account, so easy mode can paint the
// account/Sign out entries instantly on startup instead of waiting for the auth
// extension to activate and restore the session (which is visibly slow on cold start).
const ACCOUNT_CACHE_KEY = 'aria.account.displayCache';

/**
 * In easy mode the developer status bar is stripped down; the signed-in account
 * and a Sign out button (previously only in the launch overlay) move to the
 * bottom-right of the (thicker) status bar. Only shown in easy mode - advanced
 * mode keeps the stock status bar.
 */
export class AriaAccountStatusContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.aria.accountStatus';

	private accountEntry: IStatusbarEntryAccessor | undefined;
	private changeProjectEntry: IStatusbarEntryAccessor | undefined;
	private signOutEntry: IStatusbarEntryAccessor | undefined;
	private session: AuthenticationSession | undefined;
	private provider: string | undefined;

	constructor(
		@IStatusbarService private readonly statusbarService: IStatusbarService,
		@IAuthenticationService private readonly authService: IAuthenticationService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@ICommandService private readonly commandService: ICommandService,
		@IStorageService private readonly storageService: IStorageService,
	) {
		super();

		this._register(CommandsRegistry.registerCommand(SIGN_OUT_COMMAND, () => this.signOut()));
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
		if (this.configurationService.getValue(ARIA_MODE_SETTING) !== 'easy') {
			this.disposeEntries();   // advanced mode keeps the stock status bar
			return;
		}
		if (this.session) {
			const name = this.session.account.label || localize('aria.account.fallback', "Aria user");
			// The provider (google / orcid) comes from the extension (scopes are []).
			const label = this.provider ? `${name} (${this.provider})` : name;
			this.storageService.store(ACCOUNT_CACHE_KEY, JSON.stringify({ label }), StorageScope.APPLICATION, StorageTarget.MACHINE);
			this.paint(label);
			return;
		}
		// Easy, session not known yet: keep the last-known account rather than blank.
		const cached = this.cachedLabel();
		if (cached) {
			this.paint(cached);
		} else {
			this.disposeEntries();
		}
	}

	private paint(label: string): void {
		this.disposeEntries();

		this.accountEntry = this.statusbarService.addEntry({
			name: localize('aria.account.name', "Aria account"),
			text: `$(account) ${label}`,
			ariaLabel: localize('aria.account.ariaLabel', "Signed in as {0}", label),
			tooltip: localize('aria.account.tooltip', "Signed in to Aria"),
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
			tooltip: localize('aria.signout.tooltip', "Sign out of Aria"),
			command: SIGN_OUT_COMMAND,
		}, 'aria.signout', StatusbarAlignment.RIGHT, 98);
	}

	private async changeProject(): Promise<void> {
		// Close the folder WITHOUT signing out. The window reloads into an empty
		// workbench where the Started overlay - since a session and an AI-provider
		// choice already exist - skips login and the AI picker and shows the
		// project picker directly, so the user can open/create another project.
		try {
			await this.commandService.executeCommand('workbench.action.closeFolder');
		} catch {
			// ignore - e.g. already an empty workbench.
		}
	}

	private async signOut(): Promise<void> {
		if (!this.session) {
			return;
		}
		try {
			await this.authService.removeSession(AUTH_ID, this.session.id);
		} catch {
			// ignore - onDidChangeSessions will refresh regardless.
		}
		// Explicit sign-out: forget the cached account so the bar clears now and
		// doesn't optimistically repaint it.
		this.session = undefined;
		this.storageService.remove(ACCOUNT_CACHE_KEY, StorageScope.APPLICATION);
		this.reconcile();

		// The login gate only checks at startup, so signing out inside a project
		// window won't return us to the login screen on its own. Close the folder
		// (same as the gate) - VS Code reopens as an empty workbench where the
		// Started overlay shows the login surface.
		try {
			await this.commandService.executeCommand('workbench.action.closeFolder');
		} catch {
			// ignore - e.g. already an empty workbench.
		}
	}
}
