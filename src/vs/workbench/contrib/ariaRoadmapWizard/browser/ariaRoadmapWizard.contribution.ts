/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { FileAccess } from '../../../../base/common/network.js';
import { localize, localize2 } from '../../../../nls.js';
import { IWorkbenchContribution, IWorkbenchContributionsRegistry, Extensions as WorkbenchExtensions } from '../../../common/contributions.js';
import { LifecyclePhase } from '../../../services/lifecycle/common/lifecycle.js';
import { CommandsRegistry, ICommandService } from '../../../../platform/commands/common/commands.js';
import { IContextKeyService, RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IWorkspaceContextService, WorkbenchState } from '../../../../platform/workspace/common/workspace.js';
import { joinPath } from '../../../../base/common/resources.js';
import { EditorExtensions } from '../../../common/editor.js';
import { EditorPaneDescriptor, IEditorPaneRegistry } from '../../../browser/editor.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { ViewContainer, ViewContainerLocation, IViewContainersRegistry, Extensions as ViewContainerExtensions, IViewsRegistry, Extensions as ViewExtensions, IViewDescriptor } from '../../../common/views.js';
import { ViewPaneContainer } from '../../../browser/parts/views/viewPaneContainer.js';
import { AriaRoadmapEditorPane } from './ariaRoadmapEditorPane.js';
import { AriaRoadmapEditorInput } from './ariaRoadmapEditorInput.js';
import { AriaRoadmapView } from './ariaRoadmapView.js';
import { notifyRoadmapStateChanged } from './ariaRoadmapWizardCommon.js';

// --- Editor (the New Project wizard) ---------------------------------------

Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
	EditorPaneDescriptor.create(
		AriaRoadmapEditorPane,
		AriaRoadmapEditorPane.ID,
		localize('aria.roadmap.editorPaneName', "Roadmap Wizard")
	),
	[
		new SyncDescriptor(AriaRoadmapEditorInput)
	]
);

/**
 * Aria Roadmap Wizard contribution.
 *
 * Owns the entry-point command `aria.roadmap.openWizard` (called by Started's
 * "New Project" card) and the state-change sink `aria.roadmap.workbench.onStateChange`
 * (fired by the aria-roadmap extension after every mutation).
 *
 * Opening the wizard now means opening a real editor and revealing Claude Code's
 * chat in the auxiliary side bar alongside it — no full-viewport overlay, so the
 * chat renders natively in the same window instead of behind a hide/restore CSS
 * mask. The Started overlay watches for this editor and steps aside / returns on
 * its own (see ariaStartedOverlay.contribution.ts).
 */
class AriaRoadmapWizardContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.aria.roadmapWizard';

	constructor(
		@ICommandService private readonly commandService: ICommandService,
		@IEditorService private readonly editorService: IEditorService,
	) {
		super();

		this._register(CommandsRegistry.registerCommand('aria.roadmap.openWizard', () => {
			void this.openWizard();
		}));

		// One-shot: New Project created a folder and reloaded into it with this
		// flag set — auto-open the wizard canvas in the fresh project window.
		try {
			if (sessionStorage.getItem('aria.roadmap.autoOpenWizard') === '1') {
				sessionStorage.removeItem('aria.roadmap.autoOpenWizard');
				void this.openWizard();
			}
		} catch { /* storage unavailable — user can open via the Roadmap sidebar */ }

		// The aria-roadmap extension fires this after every state mutation
		// (MCP tool call or workbench-side action). Re-broadcast to the open
		// editor pane via the shared signal.
		this._register(CommandsRegistry.registerCommand('aria.roadmap.workbench.onStateChange', (_accessor, snapshot?: unknown) => {
			if (snapshot && typeof snapshot === 'object') {
				notifyRoadmapStateChanged(snapshot as Parameters<typeof notifyRoadmapStateChanged>[0]);
			}
		}));
	}

	private async openWizard(): Promise<void> {
		// Open (or focus, since the input is a Singleton) the wizard editor.
		await this.editorService.openEditor(new AriaRoadmapEditorInput(), { pinned: true });

		// Reveal the existing Claude Code chat in the auxiliary side bar next to
		// the canvas. We do NOT seed a prompt here — Claude Code's sidebar
		// chat cannot be injected with one. Instead the canvas shows a copyable
		// "starter prompt" the user pastes into this chat to kick off the
		// brainstorming (see AriaRoadmapEditorPane's empty state). Fire-and-forget.
		try {
			await this.commandService.executeCommand('workbench.action.focusAuxiliaryBar');
		} catch { /* aux bar may already be open */ }
		try {
			await this.commandService.executeCommand('claudeVSCodeSidebarSecondary.focus');
		} catch {
			try {
				await this.commandService.executeCommand('claude-vscode.sidebar.open');
			} catch { /* Claude Code not ready yet — non-fatal */ }
		}
	}
}

Registry.as<IWorkbenchContributionsRegistry>(WorkbenchExtensions.Workbench)
	.registerWorkbenchContribution(AriaRoadmapWizardContribution, LifecyclePhase.Restored);

// --- Sidebar Roadmap view (project window) ---------------------------------

const ROADMAP_CONTAINER_ID = 'workbench.view.ariaRoadmap';

/** Set true once `<workspace>/.aria/roadmap.json` exists, gating the sidebar
 *  view so the Roadmap activity-bar entry only appears for projects that
 *  actually have a saved roadmap. */
const RoadmapFilePresentContext = new RawContextKey<boolean>('aria.roadmapFilePresent', false);

// Custom roadmap activity-bar icon (winding road + waypoints + goal flag),
// matching the requested graphic. The activity bar masks the SVG to a single
// theme colour, so this is line-art that renders in the activity-bar foreground
// (highlighted when active) rather than the 2-colour source image.
const roadmapIcon = FileAccess.asBrowserUri('vs/workbench/contrib/ariaRoadmapWizard/browser/media/roadmap.svg');

const roadmapContainer: ViewContainer = Registry.as<IViewContainersRegistry>(ViewContainerExtensions.ViewContainersRegistry)
	.registerViewContainer({
		id: ROADMAP_CONTAINER_ID,
		title: localize2('aria.roadmap.containerTitle', "Roadmap"),
		ctorDescriptor: new SyncDescriptor(ViewPaneContainer, [ROADMAP_CONTAINER_ID, { mergeViewWithContainerWhenSingleView: true }]),
		hideIfEmpty: true,
		icon: roadmapIcon,
		order: 3,
	}, ViewContainerLocation.Sidebar, { doNotRegisterOpenCommand: false });

const roadmapView: IViewDescriptor = {
	id: AriaRoadmapView.ID,
	name: localize2('aria.roadmap.viewName', "Roadmap"),
	containerIcon: roadmapIcon,
	ctorDescriptor: new SyncDescriptor(AriaRoadmapView),
	canToggleVisibility: true,
	canMoveView: true,
	when: RoadmapFilePresentContext,
	order: 1,
};

Registry.as<IViewsRegistry>(ViewExtensions.ViewsRegistry).registerViews([roadmapView], roadmapContainer);

/**
 * Keeps the `aria.roadmapFilePresent` context key in sync with whether the
 * current project has a `.aria/roadmap.json`, so the Roadmap sidebar view
 * appears exactly when there is a roadmap to show (including right after the
 * wizard saves one and the window reloads into the new folder).
 */
class AriaRoadmapContextContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.aria.roadmapContext';

	private readonly present = RoadmapFilePresentContext.bindTo(this.contextKeyService);

	constructor(
		@IContextKeyService private readonly contextKeyService: IContextKeyService,
		@IFileService private readonly fileService: IFileService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
	) {
		super();
		void this.update();
		this._register(this.workspaceContextService.onDidChangeWorkbenchState(() => this.update()));
		this._register(this.workspaceContextService.onDidChangeWorkspaceFolders(() => this.update()));
		this._register(this.fileService.onDidFilesChange(e => {
			const uri = this.roadmapFileUri();
			if (uri && e.contains(uri)) {
				void this.update();
			}
		}));
	}

	private roadmapFileUri() {
		const folder = this.workspaceContextService.getWorkspace().folders[0];
		if (!folder) {
			return undefined;
		}
		return joinPath(folder.uri, '.aria', 'roadmap.json');
	}

	private async update(): Promise<void> {
		if (this.workspaceContextService.getWorkbenchState() === WorkbenchState.EMPTY) {
			this.present.set(false);
			return;
		}
		const uri = this.roadmapFileUri();
		if (!uri) {
			this.present.set(false);
			return;
		}
		let exists = false;
		try {
			exists = await this.fileService.exists(uri);
		} catch {
			exists = false;
		}
		this.present.set(exists);
	}
}

Registry.as<IWorkbenchContributionsRegistry>(WorkbenchExtensions.Workbench)
	.registerWorkbenchContribution(AriaRoadmapContextContribution, LifecyclePhase.Restored);
