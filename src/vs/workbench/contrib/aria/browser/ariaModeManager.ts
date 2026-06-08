/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { IConfigurationService, ConfigurationTarget } from '../../../../platform/configuration/common/configuration.js';
import { IContextKey, IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';
import { ARIA_MODE_SETTING, AriaMode, AriaModeContextKey } from '../common/ariaConfiguration.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IHostService } from '../../../services/host/browser/host.js';
import { localize } from '../../../../nls.js';
// Note: ARIA_SWITCH_MODE_COMMAND keeps the original toggle-with-confirm semantics
// for legacy callers; the new segmented status bar uses ARIA_SET_MODE_COMMAND
// for instant, no-confirm switching.

/**
 * Reads aria.mode from configuration, binds it to the `aria.mode` context key
 * so it can be used in `when` clauses across the workbench, and re-binds when
 * the setting changes.
 */
export class AriaModeManager extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.aria.modeManager';

	private readonly modeKey: IContextKey<AriaMode>;

	constructor(
		@IContextKeyService contextKeyService: IContextKeyService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
	) {
		super();
		this.modeKey = AriaModeContextKey.bindTo(contextKeyService);
		this.update();

		this._register(this.configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(ARIA_MODE_SETTING)) {
				this.update();
			}
		}));
	}

	private update(): void {
		const mode = this.configurationService.getValue<AriaMode>(ARIA_MODE_SETTING) ?? '';
		this.modeKey.set(mode);
		void this.syncGitEnabledFor(mode);
	}

	/**
	 * Aria's two modes drive the built-in Git extension's visibility:
	 *  - Easy mode    → `git.enabled = false` so the Source Control view
	 *                   and all git UI disappear. The on-disk `.git/` is
	 *                   untouched; Aria's own Versions view is what the
	 *                   user sees instead.
	 *  - Advanced mode → `git.enabled = true` so Source Control / Git
	 *                    commands behave exactly like upstream VS Code.
	 *  - Unset mode    → leave whatever the user has; we only flip the
	 *                    setting on an explicit choice.
	 */
	private async syncGitEnabledFor(mode: AriaMode): Promise<void> {
		if (mode !== 'easy' && mode !== 'advanced') {
			return;
		}
		const desired = mode === 'advanced';
		const current = this.configurationService.getValue<boolean>('git.enabled');
		if (current === desired) {
			return;
		}
		try {
			await this.configurationService.updateValue('git.enabled', desired, ConfigurationTarget.USER);
		} catch {
			// Best-effort: silent on failure (e.g. read-only settings).
		}
	}
}

// Command — switch mode (used by status bar entry and other UI)
export const ARIA_SWITCH_MODE_COMMAND = 'aria.switchMode';
export const ARIA_SET_MODE_COMMAND = 'aria.setMode';

CommandsRegistry.registerCommand(ARIA_SWITCH_MODE_COMMAND, async (accessor: ServicesAccessor) => {
	const configurationService = accessor.get(IConfigurationService);
	const dialogService = accessor.get(IDialogService);
	const hostService = accessor.get(IHostService);

	const current = configurationService.getValue<AriaMode>(ARIA_MODE_SETTING) ?? '';
	const next: AriaMode = current === 'easy' ? 'advanced' : 'easy';

	const result = await dialogService.confirm({
		message: localize('aria.switchMode.confirm', "Switch to {0} mode? The window will reload to apply.", next),
		primaryButton: localize('aria.switchMode.reload', "Reload"),
	});
	if (!result.confirmed) {
		return;
	}

	await configurationService.updateValue(ARIA_MODE_SETTING, next, ConfigurationTarget.APPLICATION);
	await hostService.reload();
});

CommandsRegistry.registerCommand(ARIA_SET_MODE_COMMAND, async (accessor: ServicesAccessor, mode: AriaMode) => {
	if (mode !== 'easy' && mode !== 'advanced') {
		return;
	}
	const configurationService = accessor.get(IConfigurationService);

	const current = configurationService.getValue<AriaMode>(ARIA_MODE_SETTING) ?? '';
	if (current === mode) {
		return;
	}

	// Instant switch — no confirmation, no reload. The aria.mode context key
	// updates immediately, which is enough for `when` clauses and view filters.
	// (If later we add settings that are only read at startup, we can reload
	// selectively from those code paths.)
	await configurationService.updateValue(ARIA_MODE_SETTING, mode, ConfigurationTarget.APPLICATION);
});
