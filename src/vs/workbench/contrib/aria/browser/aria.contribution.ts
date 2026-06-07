/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Side-effect import — registers the `aria.mode` configuration setting.
import '../common/ariaConfiguration.js';

import { Registry } from '../../../../platform/registry/common/platform.js';
import { IWorkbenchContributionsRegistry, Extensions as WorkbenchExtensions, IWorkbenchContribution } from '../../../common/contributions.js';
import { LifecyclePhase } from '../../../services/lifecycle/common/lifecycle.js';
import { EditorPaneDescriptor, IEditorPaneRegistry } from '../../../browser/editor.js';
import { EditorExtensions } from '../../../common/editor.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IWorkspaceContextService, WorkbenchState } from '../../../../platform/workspace/common/workspace.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';

import { AriaModeManager } from './ariaModeManager.js';
import { AriaModeStatusBarContribution } from './ariaStatusBar.contribution.js';
import { AriaStartPagePane } from './ariaStartPage/ariaStartPagePane.js';
import { AriaStartPageInput } from './ariaStartPage/ariaStartPageInput.js';
import { ARIA_MODE_SETTING, AriaMode } from '../common/ariaConfiguration.js';

const workbenchRegistry = Registry.as<IWorkbenchContributionsRegistry>(WorkbenchExtensions.Workbench);

// Mode infrastructure
workbenchRegistry.registerWorkbenchContribution(AriaModeManager, LifecyclePhase.Restored);
workbenchRegistry.registerWorkbenchContribution(AriaModeStatusBarContribution, LifecyclePhase.Restored);

// Aria Start Page editor
Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
	EditorPaneDescriptor.create(
		AriaStartPagePane,
		AriaStartPagePane.ID,
		localize('aria.startPage.label', "Aria Start Page")
	),
	[new SyncDescriptor(AriaStartPageInput)]
);

/**
 * Auto-open the Aria Start Page when:
 *  - The user has not yet chosen a mode (`aria.mode === ''`), OR
 *  - No workspace is open (first run, empty window)
 *
 * This runs on workbench restore so it doesn't fight with the user
 * actively opening a folder.
 */
class AriaStartPageBootstrap extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.aria.startPageBootstrap';

	constructor(
		@IEditorService editorService: IEditorService,
		@IConfigurationService configurationService: IConfigurationService,
		@IWorkspaceContextService workspaceContextService: IWorkspaceContextService,
	) {
		super();

		const mode = configurationService.getValue<AriaMode>(ARIA_MODE_SETTING) ?? '';
		const state = workspaceContextService.getWorkbenchState();
		const emptyWindow = state === WorkbenchState.EMPTY;
		const noEditorOpen = editorService.activeEditor === undefined;

		if (mode === '' || (emptyWindow && noEditorOpen)) {
			editorService.openEditor(new AriaStartPageInput(), { pinned: true });
		}
	}
}

workbenchRegistry.registerWorkbenchContribution(AriaStartPageBootstrap, LifecyclePhase.Restored);
