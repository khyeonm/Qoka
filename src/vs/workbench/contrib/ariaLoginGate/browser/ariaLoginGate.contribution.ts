/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IWorkbenchContribution, IWorkbenchContributionsRegistry, Extensions as WorkbenchExtensions } from '../../../common/contributions.js';
import { LifecyclePhase } from '../../../services/lifecycle/common/lifecycle.js';
import { IAuthenticationService } from '../../../services/authentication/common/authentication.js';
import { IWorkspaceContextService, WorkbenchState } from '../../../../platform/workspace/common/workspace.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';

/**
 * Login guard for folder windows.
 *
 * Sign-in lives in the Aria "Started" overlay, which is shown for an EMPTY
 * workbench and presents login → account banner → project picker as one surface.
 * That overlay only exists when no folder is open, so this guard covers the
 * other case:
 *
 *   - EMPTY workbench   → do nothing; the Started overlay owns login + picker.
 *   - folder open, session present → nothing; use the workbench normally.
 *   - folder open, NO session      → close the folder, which reloads into an
 *                                    empty workbench where the Started overlay
 *                                    shows login (recovers "signed out in a
 *                                    project").
 *
 * No pre-paint workbench hide: on the common path (a restored project with a
 * valid session) the workbench should just load normally, with no artificial
 * black screen. A signed-out folder window briefly shows before it closes —
 * an acceptable, rare cost.
 */

const AUTH_ID = 'aria';

class AriaLoginGateContribution extends Disposable implements IWorkbenchContribution {

	constructor(
		@IAuthenticationService private readonly authService: IAuthenticationService,
		@IWorkspaceContextService private readonly contextService: IWorkspaceContextService,
		@ICommandService private readonly commandService: ICommandService,
	) {
		super();

		// EMPTY workbench: the Started overlay handles sign-in + picker.
		if (this.contextService.getWorkbenchState() === WorkbenchState.EMPTY) {
			return;
		}

		void this._guardFolderWindow();
	}

	private async _guardFolderWindow(): Promise<void> {
		let hasSession = false;
		try {
			const sessions = await this.authService.getSessions(AUTH_ID, undefined, undefined, true);
			hasSession = sessions.length > 0;
		} catch {
			hasSession = false;
		}

		if (hasSession) {
			return;
		}

		// Signed out in a project window → close the folder. VS Code reloads into
		// an empty workbench, where the Started overlay shows the login surface.
		try {
			await this.commandService.executeCommand('workbench.action.closeFolder');
		} catch {
			/* ignore */
		}
	}
}

Registry.as<IWorkbenchContributionsRegistry>(WorkbenchExtensions.Workbench)
	.registerWorkbenchContribution(AriaLoginGateContribution, LifecyclePhase.Restored);
