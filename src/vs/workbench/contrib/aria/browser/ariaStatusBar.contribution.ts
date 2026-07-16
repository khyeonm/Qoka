/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IStatusbarEntryAccessor, IStatusbarService, StatusbarAlignment } from '../../../services/statusbar/browser/statusbar.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';
import { ARIA_MODE_SETTING, AriaMode } from '../common/ariaConfiguration.js';
import { ARIA_SET_MODE_COMMAND } from './ariaModeManager.js';
import { localize } from '../../../../nls.js';

/**
 * Two adjacent status bar entries - `[🧪 Easy] [👩‍💻 Advanced]` - that
 * behave like a segmented toggle. The active mode is highlighted with the
 * status bar's prominent style; clicking the inactive entry instantly
 * switches to that mode.
 */
export class AriaModeStatusBarContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.aria.modeStatusBar';

	private static readonly EASY_ENTRY_ID = 'aria.mode.easy';
	private static readonly ADVANCED_ENTRY_ID = 'aria.mode.advanced';

	private easyEntry: IStatusbarEntryAccessor | undefined;
	private advancedEntry: IStatusbarEntryAccessor | undefined;

	constructor(
		@IStatusbarService private readonly statusbarService: IStatusbarService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
	) {
		super();
		this.update();

		this._register(this.configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(ARIA_MODE_SETTING)) {
				this.update();
			}
		}));

		this._register({
			dispose: () => {
				this.easyEntry?.dispose();
				this.advancedEntry?.dispose();
			}
		});
	}

	private update(): void {
		const mode = this.configurationService.getValue<AriaMode>(ARIA_MODE_SETTING) ?? '';

		// Active mode uses the prominent status bar style; inactive is the default style.
		const easyActive = mode === 'easy';
		const advancedActive = mode === 'advanced';

		const easyData = {
			name: localize('aria.mode.easy.name', "Aria - Easy Mode"),
			text: '$(beaker) Easy',
			ariaLabel: localize('aria.mode.easy.aria', "Switch Aria to Easy mode"),
			tooltip: easyActive
				? localize('aria.mode.easy.activeTooltip', "Aria is in Easy mode")
				: localize('aria.mode.easy.inactiveTooltip', "Click to switch Aria to Easy mode"),
			command: { id: ARIA_SET_MODE_COMMAND, title: 'Set Aria Mode to Easy', arguments: ['easy' as AriaMode] },
			backgroundColor: easyActive ? { id: 'statusBarItem.prominentBackground' } : undefined,
			color: easyActive ? { id: 'statusBarItem.prominentForeground' } : undefined,
		};

		const advancedData = {
			name: localize('aria.mode.advanced.name', "Aria - Advanced Mode"),
			text: '$(tools) Advanced',
			ariaLabel: localize('aria.mode.advanced.aria', "Switch Aria to Advanced mode"),
			tooltip: advancedActive
				? localize('aria.mode.advanced.activeTooltip', "Aria is in Advanced mode")
				: localize('aria.mode.advanced.inactiveTooltip', "Click to switch Aria to Advanced mode"),
			command: { id: ARIA_SET_MODE_COMMAND, title: 'Set Aria Mode to Advanced', arguments: ['advanced' as AriaMode] },
			backgroundColor: advancedActive ? { id: 'statusBarItem.prominentBackground' } : undefined,
			color: advancedActive ? { id: 'statusBarItem.prominentForeground' } : undefined,
		};

		// RIGHT-aligned so every Aria bottom-bar control lives on the right together
		// with the account / Change project / Sign out cluster - the left side stays
		// clean (no stray Aria buttons there). Priority > the account entry's 100 so
		// the toggle sits just left of the account within the right group
		// (higher priority = further left). Easy just left of Advanced.
		if (this.easyEntry) {
			this.easyEntry.update(easyData);
		} else {
			this.easyEntry = this.statusbarService.addEntry(
				easyData,
				AriaModeStatusBarContribution.EASY_ENTRY_ID,
				StatusbarAlignment.RIGHT,
				200
			);
		}

		if (this.advancedEntry) {
			this.advancedEntry.update(advancedData);
		} else {
			this.advancedEntry = this.statusbarService.addEntry(
				advancedData,
				AriaModeStatusBarContribution.ADVANCED_ENTRY_ID,
				StatusbarAlignment.RIGHT,
				199
			);
		}
	}
}
