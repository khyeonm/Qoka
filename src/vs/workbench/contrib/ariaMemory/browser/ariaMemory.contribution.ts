/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Registry } from '../../../../platform/registry/common/platform.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { registerIcon } from '../../../../platform/theme/common/iconRegistry.js';
import { registerThemingParticipant } from '../../../../platform/theme/common/themeService.js';
import { localize, localize2 } from '../../../../nls.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { CommandsRegistry, ICommandService } from '../../../../platform/commands/common/commands.js';
import './ariaMemoryRefresh.js';
import { ViewContainer, ViewContainerLocation, IViewContainersRegistry, Extensions as ViewContainerExtensions, IViewsRegistry, Extensions as ViewExtensions, IViewDescriptor } from '../../../common/views.js';
import { IWorkbenchContribution, IWorkbenchContributionsRegistry, Extensions as WorkbenchExtensions } from '../../../common/contributions.js';
import { LifecyclePhase } from '../../../services/lifecycle/common/lifecycle.js';
import { IWorkbenchLayoutService, Parts } from '../../../services/layout/browser/layoutService.js';
import { IPaneCompositePartService } from '../../../services/panecomposite/browser/panecomposite.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { ViewPaneContainer } from '../../../browser/parts/views/viewPaneContainer.js';
import { EditorExtensions } from '../../../common/editor.js';
import { EditorPaneDescriptor, IEditorPaneRegistry } from '../../../browser/editor.js';
import { AriaMemoryView } from './ariaMemoryView.js';
import { AriaMemoryEditorPane } from './ariaMemoryEditorPane.js';
import { AriaMemoryEditorInput } from './ariaMemoryEditorInput.js';

/**
 * Memory - a left-sidebar tab that opens a centered, full-width editor with two
 * sections: this project's memory (local wiki files) and global memory (the user's
 * mem0 store, needs sign-in). Like Settings / Project Overview, selecting its
 * activity-bar icon opens the editor and collapses the sidebar.
 */

const MEMORY_CONTAINER_ID = 'workbench.view.ariaMemory';

// Base codicon, overridden below with the SD-card SVG via mask-image (the same
// technique the Autopipe tab uses for its custom glyph).
const memoryIcon = registerIcon('aria-memory-view', Codicon.save, localize('aria.memory.iconLabel', "Qoka Memory activity bar icon"));

// The user-supplied SD-card artwork, inlined as a URL-encoded SVG data URI so the
// workbench bundle has no external asset. Rendered via mask-image so the glyph
// follows the activity bar's theme color (selected vs dimmed, light vs dark).
const MEMORY_ICON_SVG_DATA_URI = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23000' stroke-width='1.7' stroke-linejoin='round' stroke-linecap='round'%3E%3Cpath d='M6.5 3.2H15L18.8 7V19.8A1.6 1.6 0 0 1 17.2 21.4H6.5A1.6 1.6 0 0 1 4.9 19.8V4.8A1.6 1.6 0 0 1 6.5 3.2Z'/%3E%3Cpath d='M8 5.6V8'/%3E%3Cpath d='M10.4 5.6V8'/%3E%3Cpath d='M12.8 5.6V8'/%3E%3Cpath d='M15.2 5.6V8'/%3E%3Crect x='7.4' y='13' width='8.8' height='5' rx='0.6'/%3E%3C/svg%3E";

registerThemingParticipant((_theme, collector) => {
	const url = `url("${MEMORY_ICON_SVG_DATA_URI}")`;
	collector.addRule(`
		.codicon-aria-memory-view::before {
			content: '';
			display: inline-block;
			width: 28px;
			height: 28px;
			background-color: currentColor;
			-webkit-mask-image: ${url};
			mask-image: ${url};
			-webkit-mask-repeat: no-repeat;
			mask-repeat: no-repeat;
			-webkit-mask-size: contain;
			mask-size: contain;
			-webkit-mask-position: center;
			mask-position: center;
		}
	`);
});

const memoryContainer: ViewContainer = Registry.as<IViewContainersRegistry>(ViewContainerExtensions.ViewContainersRegistry)
	.registerViewContainer({
		id: MEMORY_CONTAINER_ID,
		title: localize2('aria.memory.containerTitle', "Memory"),
		ctorDescriptor: new SyncDescriptor(ViewPaneContainer, [MEMORY_CONTAINER_ID, { mergeViewWithContainerWhenSingleView: true }]),
		hideIfEmpty: false,
		icon: memoryIcon,
		// Just above Settings (order 100) at the bottom of the activity bar.
		order: 99,
	}, ViewContainerLocation.Sidebar, { doNotRegisterOpenCommand: false });

const memoryView: IViewDescriptor = {
	id: AriaMemoryView.ID,
	name: localize2('aria.memory.viewName', "Memory"),
	containerIcon: memoryIcon,
	ctorDescriptor: new SyncDescriptor(AriaMemoryView),
	canToggleVisibility: false,
	canMoveView: false,
	order: 1,
};

Registry.as<IViewsRegistry>(ViewExtensions.ViewsRegistry).registerViews([memoryView], memoryContainer);

// --- Editor -----------------------------------------------------------------

Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
	EditorPaneDescriptor.create(
		AriaMemoryEditorPane,
		AriaMemoryEditorPane.ID,
		localize('aria.memory.editorPaneName', "Memory")
	),
	[
		new SyncDescriptor(AriaMemoryEditorInput)
	]
);

/** Open the centered Memory editor. */
CommandsRegistry.registerCommand('aria.memory.open', async (accessor) => {
	await accessor.get(IEditorService).openEditor(new AriaMemoryEditorInput(), { pinned: true });
});

// --- Full-width layout orchestration ----------------------------------------

class AriaMemoryLayoutContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.aria.memoryLayout';

	constructor(
		@IPaneCompositePartService paneCompositeService: IPaneCompositePartService,
		@IWorkbenchLayoutService private readonly layoutService: IWorkbenchLayoutService,
		@ICommandService private readonly commandService: ICommandService,
	) {
		super();
		this._register(paneCompositeService.onDidPaneCompositeOpen(e => {
			if (e.viewContainerLocation !== ViewContainerLocation.Sidebar) { return; }
			if (e.composite.getId() === MEMORY_CONTAINER_ID) {
				void this.commandService.executeCommand('aria.memory.open');
				try { this.layoutService.setPartHidden(true, Parts.SIDEBAR_PART); } catch { /* layout not ready */ }
			}
		}));
	}
}

Registry.as<IWorkbenchContributionsRegistry>(WorkbenchExtensions.Workbench)
	.registerWorkbenchContribution(AriaMemoryLayoutContribution, LifecyclePhase.Restored);
