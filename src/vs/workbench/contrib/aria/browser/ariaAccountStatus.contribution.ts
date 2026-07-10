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
import { ARIA_MODE_SETTING } from '../common/ariaConfiguration.js';

const AUTH_ID = 'aria';
const SIGN_OUT_COMMAND = 'aria.account.signOut';

/**
 * In easy mode the developer status bar is stripped down; the signed-in account
 * and a Sign out button (previously only in the launch overlay) move to the
 * bottom-right of the (thicker) status bar. Only shown in easy mode — advanced
 * mode keeps the stock status bar.
 */
export class AriaAccountStatusContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.aria.accountStatus';

	private accountEntry: IStatusbarEntryAccessor | undefined;
	private signOutEntry: IStatusbarEntryAccessor | undefined;
	private session: AuthenticationSession | undefined;
	private provider: string | undefined;

	constructor(
		@IStatusbarService private readonly statusbarService: IStatusbarService,
		@IAuthenticationService private readonly authService: IAuthenticationService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@ICommandService private readonly commandService: ICommandService,
	) {
		super();

		this._register(CommandsRegistry.registerCommand(SIGN_OUT_COMMAND, () => this.signOut()));

		void this.refresh();
		this._register(this.authService.onDidChangeSessions(e => {
			if (e.providerId === AUTH_ID) {
				void this.refresh();
			}
		}));
		this._register(this.configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(ARIA_MODE_SETTING)) {
				void this.refresh();
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
		// The session carries no provider (scopes are []); the extension exposes it.
		try {
			const info = await this.commandService.executeCommand<{ provider?: string } | undefined>('aria.auth.getSession');
			this.provider = info?.provider;
		} catch {
			this.provider = undefined;
		}
		this.render();
	}

	private render(): void {
		this.accountEntry?.dispose();
		this.accountEntry = undefined;
		this.signOutEntry?.dispose();
		this.signOutEntry = undefined;

		const easy = this.configurationService.getValue(ARIA_MODE_SETTING) === 'easy';
		if (!easy || !this.session) {
			return;
		}

		const name = this.session.account.label || localize('aria.account.fallback', "Aria user");
		// The provider (google / orcid) comes from the extension (the session has
		// no provider — its scopes are []).
		const label = this.provider ? `${name} (${this.provider})` : name;
		this.accountEntry = this.statusbarService.addEntry({
			name: localize('aria.account.name', "Aria account"),
			text: `$(account) ${label}`,
			ariaLabel: localize('aria.account.ariaLabel', "Signed in as {0}", label),
			tooltip: localize('aria.account.tooltip', "Signed in to Aria"),
		}, 'aria.account', StatusbarAlignment.RIGHT, 100);

		this.signOutEntry = this.statusbarService.addEntry({
			name: localize('aria.signout.name', "Sign out"),
			text: localize('aria.signout.text', "Sign out"),
			ariaLabel: localize('aria.signout.text', "Sign out"),
			tooltip: localize('aria.signout.tooltip', "Sign out of Aria"),
			command: SIGN_OUT_COMMAND,
		}, 'aria.signout', StatusbarAlignment.RIGHT, 99);
	}

	private async signOut(): Promise<void> {
		if (!this.session) {
			return;
		}
		try {
			await this.authService.removeSession(AUTH_ID, this.session.id);
		} catch {
			// ignore — onDidChangeSessions will refresh regardless.
		}
		void this.refresh();

		// The login gate only checks at startup, so signing out inside a project
		// window won't return us to the login screen on its own. Close the folder
		// (same as the gate) — VS Code reopens as an empty workbench where the
		// Started overlay shows the login surface.
		try {
			await this.commandService.executeCommand('workbench.action.closeFolder');
		} catch {
			// ignore — e.g. already an empty workbench.
		}
	}
}
