/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Registry } from '../../../../platform/registry/common/platform.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { localize2 } from '../../../../nls.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { ViewContainer, ViewContainerLocation, IViewContainersRegistry, Extensions as ViewContainerExtensions, IViewsRegistry, Extensions as ViewExtensions, IViewDescriptor } from '../../../common/views.js';
import { ViewPaneContainer } from '../../../browser/parts/views/viewPaneContainer.js';
import { IViewsService } from '../../../services/views/common/viewsService.js';
import { IWorkbenchContribution, IWorkbenchContributionsRegistry, Extensions as WorkbenchExtensions } from '../../../common/contributions.js';
import { LifecyclePhase } from '../../../services/lifecycle/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { AriaNotebookView } from './ariaNotebookView.js';
import { NotebookModel } from './ariaNotebookModel.js';

/**
 * Qoka Notebook contribution.
 *
 * One activity-bar tab that holds the whole project's page tree - the Project
 * Overview at the root, with Roadmaps and Notes beneath it. It replaces the
 * former separate Project Overview / Roadmap / Notes tabs; each page still opens
 * its existing editor, so nothing about those editors changed here.
 */

const NOTEBOOK_CONTAINER_ID = 'workbench.view.ariaNotebook';

// A spiral-bound notebook: a tall cover filling the glyph, a spine line, and three
// short spiral rings crossing the spine on the left. Drawn large (fills the 24x24
// viewBox) so it reads clearly at activity-bar size. Inlined as a data: URI (the
// activity bar masks it to the theme foreground colour), so there is no media file.
const NOTEBOOK_ICON_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#000" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="7" y="2.5" width="14.5" height="19" rx="2.2"/><line x1="11" y1="2.5" x2="11" y2="21.5"/><path d="M4.5 7 H8"/><path d="M4.5 12 H8"/><path d="M4.5 17 H8"/></svg>';
const notebookIcon = URI.parse(`data:image/svg+xml,${encodeURIComponent(NOTEBOOK_ICON_SVG)}`);

const notebookContainer: ViewContainer = Registry.as<IViewContainersRegistry>(ViewContainerExtensions.ViewContainersRegistry)
	.registerViewContainer({
		id: NOTEBOOK_CONTAINER_ID,
		title: localize2('aria.notebook.containerTitle', "Notebook"),
		ctorDescriptor: new SyncDescriptor(ViewPaneContainer, [NOTEBOOK_CONTAINER_ID, { mergeViewWithContainerWhenSingleView: true }]),
		hideIfEmpty: false,
		icon: notebookIcon,
		// Top of the Qoka group, above the old Overview (-10) / Roadmap (-5).
		order: -12,
	}, ViewContainerLocation.Sidebar, { doNotRegisterOpenCommand: false });

// A single view so it MERGES with the container: the tab shows just one "Notebook"
// title (no duplicated header). History lives as a collapsible/resizable section
// INSIDE this view, below the page tree.
const notebookView: IViewDescriptor = {
	id: AriaNotebookView.ID,
	name: localize2('aria.notebook.viewName', "Notebook"),
	containerIcon: notebookIcon,
	ctorDescriptor: new SyncDescriptor(AriaNotebookView),
	canToggleVisibility: false,
	canMoveView: true,
	order: 1,
};

Registry.as<IViewsRegistry>(ViewExtensions.ViewsRegistry).registerViews([notebookView], notebookContainer);

// Reveal the Notebook tab in the sidebar WITHOUT toggling it shut and without
// stealing focus. Callers that open a notebook page (the overview / a roadmap / a
// note) use this so the page tree is always visible beside the editor. Executing the
// view-container command directly would hide it again when it is already active.
CommandsRegistry.registerCommand('aria.notebook.reveal', async (accessor) => {
	try { await accessor.get(IViewsService).openViewContainer(NOTEBOOK_CONTAINER_ID, false); } catch { /* sidebar optional */ }
});

/**
 * Move a project's overview + roadmaps from the old `.qoka/` location into
 * `.qoka/notebook/` on startup, so existing projects keep showing their content
 * after the layout change. Runs early (before the user opens a page) and again
 * whenever the workspace folders change; idempotent via NotebookModel.migrateLayout.
 */
class AriaNotebookLayoutMigration extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.aria.notebookLayoutMigration';

	constructor(
		@IFileService private readonly fileService: IFileService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
	) {
		super();
		void this.run();
		this._register(this.workspaceContextService.onDidChangeWorkspaceFolders(() => void this.run()));
	}

	private async run(): Promise<void> {
		for (const folder of this.workspaceContextService.getWorkspace().folders) {
			await NotebookModel.migrateLayout(folder.uri, this.fileService);
		}
	}
}

Registry.as<IWorkbenchContributionsRegistry>(WorkbenchExtensions.Workbench)
	// Must be Restored/Eventually: the deprecated registerWorkbenchContribution maps
	// the phase via toWorkbenchPhase(), which returns undefined for Ready, so a
	// Ready-phase contribution is never instantiated (the migration never runs).
	.registerWorkbenchContribution(AriaNotebookLayoutMigration, LifecyclePhase.Restored);
