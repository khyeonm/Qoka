/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Side-effect import — registers the `aria.mode` configuration setting.
import '../common/ariaConfiguration.js';

// Side-effect import — registers the full-viewport Started overlay
// contribution that locks the workbench until a project is picked.
import './ariaStartedOverlay.contribution.js';

import { Registry } from '../../../../platform/registry/common/platform.js';
import { IWorkbenchContributionsRegistry, Extensions as WorkbenchExtensions } from '../../../common/contributions.js';
import { LifecyclePhase } from '../../../services/lifecycle/common/lifecycle.js';
import { EditorPaneDescriptor, IEditorPaneRegistry } from '../../../browser/editor.js';
import { EditorExtensions } from '../../../common/editor.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { localize } from '../../../../nls.js';

import { AriaModeManager } from './ariaModeManager.js';
import { AriaModeStatusBarContribution } from './ariaStatusBar.contribution.js';
import { AriaStartPagePane } from './ariaStartPage/ariaStartPagePane.js';
import { AriaStartPageInput } from './ariaStartPage/ariaStartPageInput.js';

const workbenchRegistry = Registry.as<IWorkbenchContributionsRegistry>(WorkbenchExtensions.Workbench);

// Mode infrastructure
workbenchRegistry.registerWorkbenchContribution(AriaModeManager, LifecyclePhase.Restored);
workbenchRegistry.registerWorkbenchContribution(AriaModeStatusBarContribution, LifecyclePhase.Restored);

// Aria Start Page editor pane — kept registered for command-based
// opening (e.g. View > Welcome To Aria) but the full-viewport
// ariaStartedOverlay contribution is now the primary launch surface,
// so nothing auto-opens this editor any more.
Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
	EditorPaneDescriptor.create(
		AriaStartPagePane,
		AriaStartPagePane.ID,
		localize('aria.startPage.label', "Aria Start Page")
	),
	[new SyncDescriptor(AriaStartPageInput)]
);
