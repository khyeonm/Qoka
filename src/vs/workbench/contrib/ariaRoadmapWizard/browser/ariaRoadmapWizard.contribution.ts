/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IExtensionService } from '../../../services/extensions/common/extensions.js';
import { ExtensionIdentifier } from '../../../../platform/extensions/common/extensions.js';
import { IWorkbenchLayoutService } from '../../../services/layout/browser/layoutService.js';
import { IViewsService } from '../../../services/views/common/viewsService.js';
import { createStyleSheet } from '../../../../base/browser/domStylesheets.js';
import { PROVIDER_EXTENSION_ID } from '../../aria/browser/ariaAiProviderChoice.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { URI } from '../../../../base/common/uri.js';
import { localize, localize2 } from '../../../../nls.js';
import { IWorkbenchContribution, IWorkbenchContributionsRegistry, Extensions as WorkbenchExtensions } from '../../../common/contributions.js';
import { LifecyclePhase } from '../../../services/lifecycle/common/lifecycle.js';
import { CommandsRegistry, ICommandService } from '../../../../platform/commands/common/commands.js';
import { revealAiProviderChat } from '../../aria/browser/aiProviderChat.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
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
import { registerAriaTabHelpTitleAction } from '../../aria/browser/ariaHelpEditor.js';
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
 * Qoka Roadmap Wizard contribution.
 *
 * Owns the entry-point command `aria.roadmap.openWizard` (called by Started's
 * "New Project" card) and the state-change sink `aria.roadmap.workbench.onStateChange`
 * (fired by the aria-roadmap extension after every mutation).
 *
 * Opening the wizard now means opening a real editor and revealing Claude Code's
 * chat in the auxiliary side bar alongside it - no full-viewport overlay, so the
 * chat renders natively in the same window instead of behind a hide/restore CSS
 * mask. The Started overlay watches for this editor and steps aside / returns on
 * its own (see ariaStartedOverlay.contribution.ts).
 */
class AriaRoadmapWizardContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.aria.roadmapWizard';

	constructor(
		@ICommandService private readonly commandService: ICommandService,
		@IEditorService private readonly editorService: IEditorService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
	) {
		super();

		this._register(CommandsRegistry.registerCommand('aria.roadmap.openWizard', (_accessor, arg?: { id?: string; name?: string }) => {
			void this.openWizard(arg);
		}));

		// One-shot: New Project created a folder and reloaded into it with this
		// flag set - auto-open the wizard canvas in the fresh project window.
		try {
			if (sessionStorage.getItem('aria.roadmap.autoOpenWizard') === '1') {
				sessionStorage.removeItem('aria.roadmap.autoOpenWizard');
				void this.openWizard();
			}
		} catch { /* storage unavailable - user can open via the Roadmap sidebar */ }

		// The aria-roadmap extension fires this after every state mutation
		// (MCP tool call or workbench-side action). Re-broadcast to the open
		// editor pane via the shared signal.
		this._register(CommandsRegistry.registerCommand('aria.roadmap.workbench.onStateChange', (_accessor, snapshot?: unknown) => {
			if (snapshot && typeof snapshot === 'object') {
				notifyRoadmapStateChanged(snapshot as Parameters<typeof notifyRoadmapStateChanged>[0]);
			}
		}));
	}

	private async openWizard(arg?: { id?: string; name?: string }): Promise<void> {
		// Resolve which roadmap to open. An explicit id (from the sidebar) wins;
		// otherwise open the project's active roadmap, creating one if the project
		// has none yet. In the folder-less empty-wizard window there is no store,
		// so fall back to a transient id.
		let id = arg?.id;
		let name = arg?.name;
		// Resolving the active roadmap goes through the aria-roadmap EXTENSION's
		// commands. Those throw if the extension hasn't activated yet (a real race
		// on a fresh New Project window, seen on Windows) - which must NOT stop the
		// tab from opening. Treat every step as best-effort and fall back to a
		// transient id so the canvas always appears; it re-syncs once the
		// extension's onStateChange fires.
		if (!id) {
			try {
				id = await this.commandService.executeCommand<string | undefined>('aria.roadmap.ensureActive');
			} catch { /* extension not ready - fall back below */ }
		}
		if (!id) {
			id = 'wizard';
		}
		try {
			const snap = await this.commandService.executeCommand<{ roadmapName?: string }>('aria.roadmap.switchActive', id);
			if (!name) {
				name = snap?.roadmapName;
			}
		} catch { /* non-fatal - open with the default name */ }
		// Open (or focus - one tab per roadmap id) the roadmap editor.
		await this.editorService.openEditor(new AriaRoadmapEditorInput(id, name ?? 'Roadmap'), { pinned: true });

		// Reveal whichever AI provider chat the user installed (Claude / Codex /
		// Gemini) in the auxiliary side bar next to the canvas. We do NOT seed a
		// prompt here - the provider sidebars cannot be injected with one.
		// Instead the canvas shows a copyable "starter prompt" the user pastes
		// into the chat to kick off brainstorming (see AriaRoadmapEditorPane's
		// empty state). Fire-and-forget.
		await revealAiProviderChat(this.commandService, this.configurationService);
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
// Winding road ending in a flag. Inlined as a data: URI so there is no separate
// media file to bundle; the activity bar masks it to the theme foreground colour.
const ROADMAP_ICON_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="1.5 1 21 21" fill="none" stroke="#000" stroke-width="1.05" stroke-linecap="round" stroke-linejoin="round"><path d="M5 20 H14 a3.5 3.5 0 0 0 0-7 H10 a3.5 3.5 0 0 1 0-7 h6"/><circle cx="5" cy="20" r="1.3" fill="#000" stroke="none"/><circle cx="12" cy="13" r="1.3" fill="#000" stroke="none"/><path d="M16 6 V1.5"/><path d="M16 1.7 L20.6 3.3 L16 4.9 Z" fill="#000" stroke="none"/></svg>';
const roadmapIcon = URI.parse(`data:image/svg+xml,${encodeURIComponent(ROADMAP_ICON_SVG)}`);

const roadmapContainer: ViewContainer = Registry.as<IViewContainersRegistry>(ViewContainerExtensions.ViewContainersRegistry)
	.registerViewContainer({
		id: ROADMAP_CONTAINER_ID,
		title: localize2('aria.roadmap.containerTitle', "Roadmap"),
		ctorDescriptor: new SyncDescriptor(ViewPaneContainer, [ROADMAP_CONTAINER_ID, { mergeViewWithContainerWhenSingleView: true }]),
		hideIfEmpty: true,
		icon: roadmapIcon,
		// Sort just below Project Overview (-10) and above Explorer (0), so the
		// activity-bar order is: Project Overview, Roadmap, Explorer.
		order: -5,
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

// "How to use?" link in the view's title bar.
registerAriaTabHelpTitleAction(AriaRoadmapView.ID, 'roadmap');

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
			const dir = this.roadmapsDirUri();
			const legacy = this.legacyRoadmapFileUri();
			if ((dir && e.contains(dir)) || (legacy && e.contains(legacy))) {
				void this.update();
			}
		}));
	}

	/** Current layout: each roadmap is a file under `<folder>/.aria/roadmaps/`. */
	private roadmapsDirUri() {
		const folder = this.workspaceContextService.getWorkspace().folders[0];
		return folder ? joinPath(folder.uri, '.aria', 'roadmaps') : undefined;
	}

	/** Legacy layout: a single `<folder>/.aria/roadmap.json`. */
	private legacyRoadmapFileUri() {
		const folder = this.workspaceContextService.getWorkspace().folders[0];
		return folder ? joinPath(folder.uri, '.aria', 'roadmap.json') : undefined;
	}

	private async update(): Promise<void> {
		if (this.workspaceContextService.getWorkbenchState() === WorkbenchState.EMPTY) {
			this.present.set(false);
			return;
		}
		// The Roadmap tab shows when the project has a roadmap. New Project writes
		// `.aria/roadmaps/<id>.json`; older projects used a single
		// `.aria/roadmap.json`. Accept either - checking only the legacy path is
		// what previously hid the tab entirely after New Project.
		let exists = false;
		try {
			const dir = this.roadmapsDirUri();
			if (dir && await this.fileService.exists(dir)) {
				const stat = await this.fileService.resolve(dir);
				exists = !!stat.children?.some(c => !c.isDirectory && c.name.endsWith('.json'));
			}
			if (!exists) {
				const legacy = this.legacyRoadmapFileUri();
				exists = !!legacy && await this.fileService.exists(legacy);
			}
		} catch {
			exists = false;
		}
		this.present.set(exists);
	}
}

Registry.as<IWorkbenchContributionsRegistry>(WorkbenchExtensions.Workbench)
	.registerWorkbenchContribution(AriaRoadmapContextContribution, LifecyclePhase.Restored);

// --- Roadmap activity-bar icon pulse ---------------------------------------

/**
 * After the user finishes installing an AI provider from the New Project flow,
 * the roadmap wizard editor is usually hidden behind the Extensions view that
 * the install opened. Draw the user back by pulsing the left activity-bar
 * Roadmap icon (yellow) until they open the Roadmap view. The pulse is a pure
 * CSS animation keyed on a class toggled here; the target item is selected via
 * the `data-aria-composite-id` attribute set in compositeBarActions.ts.
 */
const ROADMAP_PULSE_CLASS = 'aria-roadmap-pulse';

class AriaRoadmapPulseContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.aria.roadmapPulse';

	private pulsing = false;
	/** Only pulse when the user JUST created a project via New Project (a one-shot
	 *  flag), never on a normal restore of an existing project. */
	private pulseRequested = false;

	constructor(
		@IExtensionService private readonly extensionService: IExtensionService,
		@IWorkbenchLayoutService private readonly layoutService: IWorkbenchLayoutService,
		@IViewsService private readonly viewsService: IViewsService,
		@IContextKeyService private readonly contextKeyService: IContextKeyService,
	) {
		super();
		this.installStyles();

		// Only pulse when the user JUST created a project via New Project. That flow
		// sets a one-shot sessionStorage flag right before it reloads into the new
		// folder; consume it here. A normal restore of an existing project (e.g. an
		// already-signed-in launch that auto-opens the last project) must NOT pulse.
		try {
			if (sessionStorage.getItem('aria.roadmap.pulseOnLoad') === '1') {
				sessionStorage.removeItem('aria.roadmap.pulseOnLoad');
				this.pulseRequested = true;
			}
		} catch { /* storage unavailable - just don't pulse */ }

		// A provider installed DURING that New Project flow can leave the roadmap
		// canvas hidden behind the Extensions view; re-pulse once one appears -
		// still gated on the New Project flag.
		this._register(this.extensionService.onDidChangeExtensions(e => {
			if (!this.pulseRequested) { return; }
			const providerIds = Object.values(PROVIDER_EXTENSION_ID);
			if (e.added.some(ext => providerIds.some(id => ExtensionIdentifier.equals(ext.identifier, id)))) {
				this.maybePulseForRoadmap();
			}
		}));

		// Stop once the user opens the Roadmap view - they got the hint.
		this._register(this.viewsService.onDidChangeViewVisibility(e => {
			if (e.id === AriaRoadmapView.ID && e.visible) {
				this.stop();
			}
		}));

		// The roadmap file is written just before the New Project reload, so the
		// context can flip true slightly after we construct - pulse once it does.
		this._register(this.contextKeyService.onDidChangeContext(e => {
			if (e.affectsSome(new Set(['aria.roadmapFilePresent']))) {
				this.maybePulseForRoadmap();
			}
		}));
		this.maybePulseForRoadmap();

		this._register(toDisposable(() => this.stop()));
	}

	/** Pulse when the project has a roadmap but its view isn't open yet. */
	private maybePulseForRoadmap(): void {
		if (this.pulseRequested
			&& this.contextKeyService.getContextKeyValue<boolean>('aria.roadmapFilePresent') === true
			&& !this.viewsService.isViewVisible(AriaRoadmapView.ID)) {
			this.start();
		}
	}

	private start(): void {
		if (this.pulsing) {
			return;
		}
		this.pulsing = true;
		this.layoutService.mainContainer.classList.add(ROADMAP_PULSE_CLASS);
	}

	private stop(): void {
		this.pulseRequested = false;
		if (!this.pulsing) {
			return;
		}
		this.pulsing = false;
		this.layoutService.mainContainer.classList.remove(ROADMAP_PULSE_CLASS);
	}

	private installStyles(): void {
		const style = createStyleSheet();
		style.textContent = `
@keyframes aria-roadmap-pulse-kf {
	0%, 100% { transform: translateY(0); }
	50%      { transform: translateY(-4px); }
}
.${ROADMAP_PULSE_CLASS} .activitybar .action-item[data-aria-composite-id="${ROADMAP_CONTAINER_ID}"] {
	background-color: rgba(255, 193, 7, 0.95);
	border-radius: 6px;
	animation: aria-roadmap-pulse-kf 0.7s ease-in-out infinite;
}
.${ROADMAP_PULSE_CLASS} .activitybar .action-item[data-aria-composite-id="${ROADMAP_CONTAINER_ID}"] .action-label {
	color: #1e1e1e !important;
}
`;
		this._register(toDisposable(() => style.remove()));
	}
}

Registry.as<IWorkbenchContributionsRegistry>(WorkbenchExtensions.Workbench)
	.registerWorkbenchContribution(AriaRoadmapPulseContribution, LifecyclePhase.Restored);
