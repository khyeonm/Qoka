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
import { localize } from '../../../../../nls.js';
import { basename } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { INotificationService, Severity } from '../../../../../platform/notification/common/notification.js';

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
		@INotificationService private readonly notificationService: INotificationService,
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

		// Header
		const { title, tagline } = this.headlineFor(mode);
		append(this.container, $('h1', undefined, title));
		append(this.container, $('p.subtitle', undefined, tagline));

		// Mode section - two large cards with descriptions.
		this.renderModeSection(this.container, mode);

		// Start section - New Project / Open Project / Recent.
		await this.renderStartSection(this.container);
	}

	private headlineFor(mode: AriaMode): { title: string; tagline: string } {
		switch (mode) {
			case 'easy':
				return {
					title: localize('aria.startPage.headline.easy', "Qoka - Easy Mode"),
					tagline: localize('aria.startPage.tagline.easy', "Simplified interface focused on research workflows."),
				};
			case 'advanced':
				return {
					title: localize('aria.startPage.headline.advanced', "Qoka - Advanced Mode"),
					tagline: localize('aria.startPage.tagline.advanced', "Full IDE experience with every VS Code feature."),
				};
			default:
				return {
					title: localize('aria.startPage.headline.welcome', "Welcome to Qoka"),
					tagline: localize('aria.startPage.tagline.welcome', "Choose a mode below to get started."),
				};
		}
	}

	private renderModeSection(parent: HTMLElement, currentMode: AriaMode): void {
		append(parent, $('h2', undefined, localize('aria.startPage.mode', "Mode")));

		const grid = append(parent, $('.aria-mode-grid'));

		const makeCard = (
			mode: 'easy' | 'advanced',
			icon: string,
			label: string,
			description: string,
		): HTMLButtonElement => {
			const card = append(grid, $('button.aria-mode-card')) as HTMLButtonElement;
			if (currentMode === mode) {
				card.classList.add('active');
			}
			const head = append(card, $('.aria-mode-card-head'));
			append(head, $('span.aria-mode-card-icon', undefined, icon));
			append(head, $('h3.aria-mode-card-title', undefined, label));
			if (currentMode === mode) {
				append(head, $('span.aria-mode-card-check', undefined, '✓'));
			}
			append(card, $('p.aria-mode-card-detail', undefined, description));
			card.onclick = () => this.commandService.executeCommand(ARIA_SET_MODE_COMMAND, mode);
			return card;
		};

		makeCard(
			'easy',
			'🌱',
			localize('aria.startPage.mode.easy', "Easy"),
			localize(
				'aria.startPage.mode.easy.detail',
				"Simplified UI focused on chat and the research side panels.",
			),
		);
		makeCard(
			'advanced',
			'⚙️',
			localize('aria.startPage.mode.advanced', "Advanced"),
			localize(
				'aria.startPage.mode.advanced.detail',
				"Full IDE layout with drag-and-resize panels and every VS Code feature.",
			),
		);

		if (currentMode === '') {
			append(
				parent,
				$(
					'p.aria-mode-status',
					undefined,
					localize(
						'aria.startPage.mode.status.unset',
						"No mode chosen yet - pick Easy or Advanced above.",
					),
				),
			);
		}
	}

	private async renderStartSection(parent: HTMLElement): Promise<void> {
		append(parent, $('h2', undefined, localize('aria.startPage.start', "Start")));

		// Top row - New Project + Open Project... side by side.
		const actionRow = append(parent, $('.aria-start-action-row'));

		const newCard = append(actionRow, $('button.aria-start-card')) as HTMLButtonElement;
		newCard.appendChild($('span.aria-start-card-icon', undefined, '⊕'));
		newCard.appendChild($('span.aria-start-card-title', undefined, localize('aria.startPage.newProject', "New Project")));
		newCard.appendChild($('span.aria-start-card-detail', undefined, localize(
			'aria.startPage.newProject.detail',
			"Start a fresh research project with AI guidance.",
		)));
		newCard.onclick = () => {
			// Chat-driven new-project flow is not implemented yet - surface
			// a brief notice instead of silently doing nothing.
			this.notificationService.notify({
				severity: Severity.Info,
				message: localize(
					'aria.startPage.newProject.comingSoon',
					"New Project flow is coming soon. For now, use Open Project to load an existing folder.",
				),
			});
		};

		const openCard = append(actionRow, $('button.aria-start-card')) as HTMLButtonElement;
		openCard.appendChild($('span.aria-start-card-icon', undefined, '📁'));
		openCard.appendChild($('span.aria-start-card-title', undefined, localize('aria.startPage.openProject', "Open Project...")));
		openCard.appendChild($('span.aria-start-card-detail', undefined, localize(
			'aria.startPage.openProject.detail',
			"Browse for a folder on your machine.",
		)));
		openCard.onclick = () => {
			void this.commandService.executeCommand('workbench.action.files.openFolder');
		};

		// Recent projects.
		await this.renderRecentProjects(parent);
	}

	private async renderRecentProjects(parent: HTMLElement): Promise<void> {
		append(parent, $('h3.aria-recent-heading', undefined, localize('aria.startPage.recent', "Recent projects")));

		let recents: IRecentlyOpened;
		try {
			recents = await this.workspacesService.getRecentlyOpened();
		} catch {
			append(parent, $('p.aria-empty-state', undefined, localize('aria.startPage.recent.unavailable', "Recent projects unavailable.")));
			return;
		}

		// Cap the visible list at 5 - the rest are reachable through the
		// standard "Open Recent" picker that VS Code already ships.
		const VISIBLE_LIMIT = 5;
		const all = recents.workspaces;
		if (all.length === 0) {
			append(parent, $('p.aria-empty-state', undefined, localize('aria.startPage.recent.empty', "No recent projects yet.")));
			return;
		}
		const items = all.slice(0, VISIBLE_LIMIT);

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
			btn.appendChild($('span.aria-recent-name', undefined, name));
			btn.appendChild($('span.aria-recent-path', undefined, path));
			btn.title = path;
			btn.onclick = () => this.commandService.executeCommand('vscode.openFolder', uri);
		}

		if (all.length > VISIBLE_LIMIT) {
			const moreBtn = append(list, $('button.aria-recent-more')) as HTMLButtonElement;
			moreBtn.textContent = localize('aria.startPage.recent.more', "Show more...");
			moreBtn.onclick = () => this.commandService.executeCommand('workbench.action.openRecent');
		}
	}

	override layout(_dimension: Dimension): void {
		// DOM flows naturally; nothing to size manually.
	}
}
