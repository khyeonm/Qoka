/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Registry } from '../../../../platform/registry/common/platform.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { registerIcon } from '../../../../platform/theme/common/iconRegistry.js';
import { localize, localize2 } from '../../../../nls.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { CommandsRegistry, ICommandService } from '../../../../platform/commands/common/commands.js';
import { ViewContainer, ViewContainerLocation, IViewContainersRegistry, Extensions as ViewContainerExtensions, IViewsRegistry, Extensions as ViewExtensions, IViewDescriptor } from '../../../common/views.js';
import { IWorkbenchContribution, IWorkbenchContributionsRegistry, Extensions as WorkbenchExtensions } from '../../../common/contributions.js';
import { LifecyclePhase } from '../../../services/lifecycle/common/lifecycle.js';
import { IWorkbenchLayoutService, Parts } from '../../../services/layout/browser/layoutService.js';
import { IPaneCompositePartService } from '../../../services/panecomposite/browser/panecomposite.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { ViewPaneContainer } from '../../../browser/parts/views/viewPaneContainer.js';
import { EditorExtensions } from '../../../common/editor.js';
import { EditorPaneDescriptor, IEditorPaneRegistry } from '../../../browser/editor.js';
import { AriaSettingsView } from './ariaSettingsView.js';
import { AriaSettingsEditorPane } from './ariaSettingsEditorPane.js';
import { AriaSettingsEditorInput } from './ariaSettingsEditorInput.js';
import { fireSkillsRefresh } from './settingsEvents.js';

/**
 * Settings - the bottom-most left-sidebar tab. Like the Project Overview, clicking
 * its activity-bar icon opens a centered, max-width editor (Providers / Connections
 * / Autopipe / Skills stacked) and collapses the sidebar; opening any other tab
 * restores the sidebar. The former Autopipe / Connections / Skills tabs are retired
 * into this one (their containers + commands stay registered so the sections reuse
 * them).
 */

const SETTINGS_CONTAINER_ID = 'workbench.view.ariaSettings';

// The reserved gear icon (settings-view-bar-icon uses Codicon.settingsGear).
const settingsIcon = registerIcon('aria-settings-view', Codicon.settingsGear, localize('aria.settings.iconLabel', "Qoka Settings activity bar icon"));

const settingsContainer: ViewContainer = Registry.as<IViewContainersRegistry>(ViewContainerExtensions.ViewContainersRegistry)
	.registerViewContainer({
		id: SETTINGS_CONTAINER_ID,
		title: localize2('aria.settings.containerTitle', "Settings"),
		ctorDescriptor: new SyncDescriptor(ViewPaneContainer, [SETTINGS_CONTAINER_ID, { mergeViewWithContainerWhenSingleView: true }]),
		hideIfEmpty: false,
		icon: settingsIcon,
		// Bottom of the activity bar (well after the other Qoka tabs).
		order: 100,
	}, ViewContainerLocation.Sidebar, { doNotRegisterOpenCommand: false });

const settingsView: IViewDescriptor = {
	id: AriaSettingsView.ID,
	name: localize2('aria.settings.viewName', "Settings"),
	containerIcon: settingsIcon,
	ctorDescriptor: new SyncDescriptor(AriaSettingsView),
	canToggleVisibility: false,
	canMoveView: false,
	order: 1,
};

Registry.as<IViewsRegistry>(ViewExtensions.ViewsRegistry).registerViews([settingsView], settingsContainer);

// --- Editor -----------------------------------------------------------------

Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
	EditorPaneDescriptor.create(
		AriaSettingsEditorPane,
		AriaSettingsEditorPane.ID,
		localize('aria.settings.editorPaneName', "Settings")
	),
	[
		new SyncDescriptor(AriaSettingsEditorInput)
	]
);

/** Open the centered Settings editor. */
CommandsRegistry.registerCommand('aria.settings.open', async (accessor) => {
	await accessor.get(IEditorService).openEditor(new AriaSettingsEditorInput(), { pinned: true });
});

// The aria-skills extension pokes this command when its state changes (a skill added
// via the wizard, keys configured, ...). The retired Skills view used to register it;
// now the Settings tab does, refreshing its Skills section if the editor is open.
CommandsRegistry.registerCommand('aria.skills.requestRefresh', () => { fireSkillsRefresh(); });

// --- Full-width layout orchestration ----------------------------------------

class AriaSettingsLayoutContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.aria.settingsLayout';

	constructor(
		@IPaneCompositePartService paneCompositeService: IPaneCompositePartService,
		@IWorkbenchLayoutService private readonly layoutService: IWorkbenchLayoutService,
		@ICommandService private readonly commandService: ICommandService,
	) {
		super();
		this._register(paneCompositeService.onDidPaneCompositeOpen(e => {
			if (e.viewContainerLocation !== ViewContainerLocation.Sidebar) { return; }
			if (e.composite.getId() === SETTINGS_CONTAINER_ID) {
				void this.commandService.executeCommand('aria.settings.open');
				try { this.layoutService.setPartHidden(true, Parts.SIDEBAR_PART); } catch { /* layout not ready */ }
			} else {
				try { this.layoutService.setPartHidden(false, Parts.SIDEBAR_PART); } catch { /* layout not ready */ }
			}
		}));
	}
}

Registry.as<IWorkbenchContributionsRegistry>(WorkbenchExtensions.Workbench)
	.registerWorkbenchContribution(AriaSettingsLayoutContribution, LifecyclePhase.Restored);
