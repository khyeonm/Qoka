/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/ariaStartPage.css';

import { EditorPane } from '../../../../browser/parts/editor/editorPane.js';
import { $, append, clearNode } from '../../../../../base/browser/dom.js';
import { Dimension } from '../../../../../base/browser/dom.js';
import { IThemeService } from '../../../../../platform/theme/common/themeService.js';
import { IStorageService } from '../../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../../platform/telemetry/common/telemetry.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IWorkspacesService, IRecentlyOpened, isRecentFolder, isRecentWorkspace } from '../../../../../platform/workspaces/common/workspaces.js';
import { IEditorGroup } from '../../../../services/editor/common/editorGroupsService.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { IEditorOptions } from '../../../../../platform/editor/common/editor.js';
import { ARIA_MODE_SETTING, AriaMode } from '../../common/ariaConfiguration.js';
import { ARIA_SET_MODE_COMMAND } from '../ariaModeManager.js';
import { getFeaturesForMode } from './ariaStartFeatures.js';
import { localize } from '../../../../../nls.js';
import { basename } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';

export class AriaStartPagePane extends EditorPane {

	static readonly ID = 'workbench.editor.aria.startPage';

	private container: HTMLElement | undefined;

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@ICommandService private readonly commandService: ICommandService,
		@IWorkspacesService private readonly workspacesService: IWorkspacesService,
	) {
		super(AriaStartPagePane.ID, group, telemetryService, themeService, storageService);

		this._register(this.configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(ARIA_MODE_SETTING)) {
				this.render();
			}
		}));
	}

	protected createEditor(parent: HTMLElement): void {
		this.container = append(parent, $('.aria-start-page'));
		this.render();
	}

	override async setInput(input: any, options: IEditorOptions | undefined, context: any, token: CancellationToken): Promise<void> {
		await super.setInput(input, options, context, token);
		this.render();
	}

	private async render(): Promise<void> {
		if (!this.container) {
			return;
		}
		clearNode(this.container);

		const mode = this.configurationService.getValue<AriaMode>(ARIA_MODE_SETTING) ?? '';

		// Header — different per mode so the user sees the page change.
		const { title, tagline } = this.headlineFor(mode);
		append(this.container, $('h1', undefined, title));
		append(this.container, $('p.subtitle', undefined, tagline));

		// Mode selector — segmented toggle
		this.renderModeToggle(this.container, mode);

		// Features (New File / Open File / Open Folder)
		this.renderFeatures(this.container, mode);

		// Recent
		await this.renderRecent(this.container);
	}

	private headlineFor(mode: AriaMode): { title: string; tagline: string } {
		switch (mode) {
			case 'easy':
				return {
					title: localize('aria.startPage.headline.easy', "Aria — Easy Mode"),
					tagline: localize('aria.startPage.tagline.easy', "Simplified interface focused on research workflows."),
				};
			case 'advanced':
				return {
					title: localize('aria.startPage.headline.advanced', "Aria — Advanced Mode"),
					tagline: localize('aria.startPage.tagline.advanced', "Full IDE experience with every VS Code feature."),
				};
			default:
				return {
					title: localize('aria.startPage.headline.welcome', "Welcome to Aria"),
					tagline: localize('aria.startPage.tagline.welcome', "Choose a mode below to get started."),
				};
		}
	}

	private renderModeToggle(parent: HTMLElement, currentMode: AriaMode): void {
		append(parent, $('h2', undefined, localize('aria.startPage.mode', "Mode")));

		const toggle = append(parent, $('.aria-mode-toggle'));

		const makeBtn = (mode: 'easy' | 'advanced', icon: string, label: string): HTMLButtonElement => {
			const btn = append(toggle, $('button.aria-mode-btn')) as HTMLButtonElement;
			if (currentMode === mode) {
				btn.classList.add('active');
				// Visible "selected" indicator inside the active button
				btn.appendChild($('span.aria-mode-check', undefined, '✓'));
			}
			btn.appendChild($('span', undefined, icon));
			btn.appendChild($('span', undefined, label));
			btn.onclick = () => this.commandService.executeCommand(ARIA_SET_MODE_COMMAND, mode);
			return btn;
		};

		makeBtn('easy', '🧪', localize('aria.startPage.mode.easy', "Easy"));
		makeBtn('advanced', '👩‍💻', localize('aria.startPage.mode.advanced', "Advanced"));

		// Status text below the toggle — makes the change unmistakable.
		const status = append(parent, $('p.aria-mode-status'));
		if (currentMode === 'easy') {
			status.textContent = localize('aria.startPage.mode.status.easy', "✓ Easy mode is active");
			status.classList.add('active');
		} else if (currentMode === 'advanced') {
			status.textContent = localize('aria.startPage.mode.status.advanced', "✓ Advanced mode is active");
			status.classList.add('active');
		} else {
			status.textContent = localize('aria.startPage.mode.status.unset', "No mode chosen yet — pick Easy or Advanced above.");
		}
	}

	private renderFeatures(parent: HTMLElement, currentMode: AriaMode): void {
		append(parent, $('h2', undefined, localize('aria.startPage.start', "Start")));

		// When mode is unset, fall back to easy's feature list so the page
		// is not empty before the user picks a mode.
		const mode: AriaMode = currentMode === '' ? 'easy' : currentMode;
		const features = getFeaturesForMode(mode);

		if (features.length === 0) {
			append(parent, $('p.aria-empty-state', undefined, localize('aria.startPage.noFeatures', "No actions available.")));
			return;
		}

		const list = append(parent, $('.aria-features'));
		for (const feature of features) {
			const btn = append(list, $('button.aria-feature')) as HTMLButtonElement;
			btn.appendChild($(`span.codicon.codicon-${feature.icon}`));
			btn.appendChild($('span.aria-feature-title', undefined, feature.title));
			btn.appendChild($('span.aria-feature-detail', undefined, feature.detail));
			btn.onclick = () => this.commandService.executeCommand(feature.command);
		}
	}

	private async renderRecent(parent: HTMLElement): Promise<void> {
		append(parent, $('h2', undefined, localize('aria.startPage.recent', "Recent")));

		let recents: IRecentlyOpened;
		try {
			recents = await this.workspacesService.getRecentlyOpened();
		} catch {
			append(parent, $('p.aria-empty-state', undefined, localize('aria.startPage.recent.unavailable', "Recent projects unavailable.")));
			return;
		}

		const items = recents.workspaces.slice(0, 8);
		if (items.length === 0) {
			append(parent, $('p.aria-empty-state', undefined, localize('aria.startPage.recent.empty', "No recent projects yet.")));
			return;
		}

		const list = append(parent, $('.aria-recent-list'));
		for (const item of items) {
			const uri: URI | undefined = isRecentFolder(item)
				? item.folderUri
				: isRecentWorkspace(item)
					? item.workspace.configPath
					: undefined;
			if (!uri) {
				continue;
			}
			const name = basename(uri) || uri.fsPath;
			const path = uri.fsPath;
			const btn = append(list, $('button.aria-recent-item')) as HTMLButtonElement;
			btn.appendChild($('span.codicon.codicon-folder'));
			btn.appendChild($('span', undefined, name));
			btn.appendChild($('span.aria-recent-path', undefined, path));
			btn.title = path;
			btn.onclick = () => this.commandService.executeCommand('vscode.openFolder', uri);
		}
	}

	override layout(_dimension: Dimension): void {
		// DOM flows naturally; nothing to size manually.
	}
}
