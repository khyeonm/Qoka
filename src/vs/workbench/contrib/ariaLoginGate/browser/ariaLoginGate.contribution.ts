/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { timeout } from '../../../../base/common/async.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IWorkbenchContribution, IWorkbenchContributionsRegistry, Extensions as WorkbenchExtensions } from '../../../common/contributions.js';
import { LifecyclePhase } from '../../../services/lifecycle/common/lifecycle.js';
import { IAuthenticationService } from '../../../services/authentication/common/authentication.js';
import { IWorkspaceContextService, WorkbenchState } from '../../../../platform/workspace/common/workspace.js';

/**
 * Login guard for folder windows.
 *
 * Sign-in is OPTIONAL: the Qoka "Started" overlay (shown for an EMPTY workbench)
 * offers "Continue without signing in", and features that need the server identity
 * (e.g. global memory) gate themselves. So this guard no longer forces sign-in - it
 * never closes a signed-out folder window. It is kept as a thin hook (and to consume
 * the one-shot skip flag) in case per-window auth handling is needed later.
 */

const AUTH_ID = 'aria';

/** One-shot flag the Started overlay sets (localStorage, value = Date.now())
 *  right before it opens a folder, since it only does so after validating a
 *  session. Mirrors LOGIN_GATE_SKIP_FLAG in ariaStartedOverlay.contribution.ts. */
const LOGIN_GATE_SKIP_FLAG = 'aria.loginGate.skipOnce';
/** Only honour the skip flag if it was set this recently (a fresh open-folder
 *  hand-off), never a stale leftover. The reload + extension-host start is a few
 *  seconds; 30s is comfortably above that and well below any real re-launch gap. */
const LOGIN_GATE_SKIP_MAX_AGE_MS = 30_000;

class AriaLoginGateContribution extends Disposable implements IWorkbenchContribution {

	constructor(
		@IAuthenticationService private readonly authService: IAuthenticationService,
		@IWorkspaceContextService private readonly contextService: IWorkspaceContextService,
	) {
		super();

		// EMPTY workbench: the Started overlay handles sign-in + picker.
		if (this.contextService.getWorkbenchState() === WorkbenchState.EMPTY) {
			return;
		}

		void this._guardFolderWindow();
	}

	private async _guardFolderWindow(): Promise<void> {
		// The overlay just opened this folder from behind its own auth gate, so a
		// session is known-good - skip the poll entirely. Without this, a fresh New
		// Project window busy installing the CLI can starve the auth restore, the
		// poll below times out, and we closeFolder - the "New Project bounce". The
		// flag is consumed here (one-shot) AND is only honoured while FRESH: a value
		// older than the window is a leftover we ignore, so it can never suppress the
		// gate on a later, genuinely-signed-out folder window.
		try {
			const raw = localStorage.getItem(LOGIN_GATE_SKIP_FLAG);
			if (raw !== null) {
				localStorage.removeItem(LOGIN_GATE_SKIP_FLAG);
				const ts = parseInt(raw, 10);
				if (!isNaN(ts) && Date.now() - ts < LOGIN_GATE_SKIP_MAX_AGE_MS) {
					return;
				}
			}
		} catch {
			/* storage unavailable - fall through to the poll */
		}

		// The aria-authentication extension restores its session from SecretStorage
		// asynchronously on activation. A short fixed poll can race that restore and
		// wrongly report "no session", bouncing a just-signed-in user back to the
		// picker the moment they open a project - most visibly right after "New
		// Project", which creates a folder and reloads into it immediately. Poll for
		// up to ~10s and return as soon as a valid (already stored) session appears,
		// so the restore always wins the race before we give up.
		for (let attempt = 0; attempt < 20; attempt++) {
			try {
				const sessions = await this.authService.getSessions(AUTH_ID, undefined, undefined, true);
				if (sessions.length > 0) {
					return;
				}
			} catch {
				/* ignore and retry */
			}
			await timeout(500);
		}

		// Signed out after retries. Sign-in is OPTIONAL now, so we do NOT close the
		// folder - a guest (or a user who chose "Continue without signing in") works
		// in the project normally. Features that genuinely need the server identity
		// (e.g. global memory) gate themselves individually with a "Sign in" prompt.
		return;
	}
}

Registry.as<IWorkbenchContributionsRegistry>(WorkbenchExtensions.Workbench)
	.registerWorkbenchContribution(AriaLoginGateContribution, LifecyclePhase.Restored);
