/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, append, Dimension } from '../../../../base/browser/dom.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { IEditorOptions } from '../../../../platform/editor/common/editor.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IAuthenticationService } from '../../../services/authentication/common/authentication.js';
import { EditorPane } from '../../../browser/parts/editor/editorPane.js';
import { IEditorOpenContext } from '../../../common/editor.js';
import { EditorInput } from '../../../common/editor/editorInput.js';
import { IEditorGroup } from '../../../services/editor/common/editorGroupsService.js';
import { applyAriaScrollbar } from '../../aria/browser/ariaScrollbar.js';
import { AriaSettingsEditorInput } from './ariaSettingsEditorInput.js';
import { SettingsSection } from './sections/settingsSection.js';
import { ProvidersSection } from './sections/providersSection.js';
import { ConnectionsSection } from './sections/connectionsSection.js';
import { AutopipeSection } from './sections/autopipeSection.js';
import { SkillsSection } from './sections/skillsSection.js';
import { onDidRequestSkillsRefresh } from './settingsEvents.js';

/** Max content width so the settings do not stretch across a wide editor. */
const MAX_WIDTH_PX = 780;

/**
 * The consolidated Settings page: Providers, Connections, Autopipe and Skills stacked
 * vertically in a centered, max-width column (so it fills the editor area like the
 * Project Overview, but reads as a tidy settings sheet rather than a full-bleed one).
 * Each section reuses the existing tab's logic through the same `aria.*` commands, so
 * the backend and its MCP tools are unchanged.
 */
export class AriaSettingsEditorPane extends EditorPane {

	static readonly ID = AriaSettingsEditorInput.EDITOR_ID;

	private column: HTMLElement | undefined;
	private readonly sectionStore = this._register(new DisposableStore());
	private sections: SettingsSection[] = [];

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@ICommandService private readonly commandService: ICommandService,
		@IAuthenticationService private readonly authenticationService: IAuthenticationService,
	) {
		super(AriaSettingsEditorPane.ID, group, telemetryService, themeService, storageService);
	}

	protected createEditor(parent: HTMLElement): void {
		const root = document.createElement('div');
		Object.assign(root.style, {
			width: '100%', height: '100%', overflow: 'auto', boxSizing: 'border-box',
			color: 'var(--vscode-foreground)', fontSize: '13px',
			background: 'var(--vscode-editor-background, #1e1e1e)',
			fontFamily: 'var(--vscode-font-family, system-ui, sans-serif)',
		});
		applyAriaScrollbar(root);
		parent.appendChild(root);

		// Centered, max-width column.
		const column = append(root, $('div'));
		Object.assign(column.style, {
			maxWidth: `${MAX_WIDTH_PX}px`, margin: '0 auto', padding: '20px 24px 48px', boxSizing: 'border-box',
		});
		const heading = append(column, $('div'));
		heading.textContent = 'Settings';
		Object.assign(heading.style, { fontSize: '22px', fontWeight: '600', margin: '4px 0 18px' });
		this.column = column;
	}

	override async setInput(input: EditorInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		await super.setInput(input, options, context, token);
		await this.buildSections();
	}

	/** (Re)build the four stacked sections. Each section owns its own refresh loop. */
	private async buildSections(): Promise<void> {
		const column = this.column;
		if (!column) { return; }
		this.sectionStore.clear();
		this.sections = [];
		// Clear everything after the heading (the first child).
		while (column.childElementCount > 1) { column.removeChild(column.lastElementChild!); }

		// Warm the shared backends first so every section's first fetch returns quickly
		// and the sections paint together, instead of Skills popping in before the rest.
		try {
			await Promise.all([
				this.commandService.executeCommand('aria.autopipe.getStatus', true),
				this.commandService.executeCommand('aria.skills.getState'),
			]);
		} catch { /* sections handle their own errors */ }
		if (!this.column) { return; }

		const add = <T extends SettingsSection>(title: string, make: (body: HTMLElement, header: HTMLElement) => T, first: boolean): T => {
			const wrap = append(column, $('div'));
			if (!first) {
				// The divider spans the full column width (pulled out past the column's
				// side padding, then re-padded) so the line reads as a section break.
				Object.assign(wrap.style, {
					borderTop: '1px solid var(--vscode-editorWidget-border, rgba(127,127,127,0.25))', marginTop: '22px', paddingTop: '20px',
					marginLeft: '-24px', marginRight: '-24px', paddingLeft: '24px', paddingRight: '24px',
				});
			}
			const head = append(wrap, $('div'));
			Object.assign(head.style, { display: 'flex', alignItems: 'center', minHeight: '20px', fontSize: '13px', fontWeight: '700', textTransform: 'uppercase', letterSpacing: '0.05em', opacity: '0.7', marginBottom: '12px' });
			const titleEl = append(head, $('span'));
			titleEl.textContent = title;
			const section = make(append(wrap, $('div')), head);
			this.sectionStore.add(section);
			this.sections.push(section);
			void section.refresh();
			return section;
		};

		add('AI Assistants', (body, header) => new ProvidersSection(body, this.commandService, header), true);
		add('Connections', (body, header) => new ConnectionsSection(body, this.commandService, header), false);
		add('Autopipe', (body, header) => new AutopipeSection(body, this.commandService, header), false);
		const skills = add('Skills', (body, header) => new SkillsSection(body, this.commandService, header), false);
		// The extension refreshes the Skills UI through aria.skills.requestRefresh.
		this.sectionStore.add(onDidRequestSkillsRefresh(() => void skills.refresh()));

		this.buildFooter(column);
	}

	/** Actions at the very bottom of the settings page. Login removed: just
	 *  Change project + Check for updates (no sign in/out or delete account). */
	private buildFooter(column: HTMLElement): void {
		const foot = append(column, $('div'));
		Object.assign(foot.style, {
			display: 'flex', gap: '10px', marginTop: '30px', paddingTop: '18px',
			borderTop: '1px solid var(--vscode-editorWidget-border, rgba(127,127,127,0.25))',
			marginLeft: '-24px', marginRight: '-24px', paddingLeft: '24px', paddingRight: '24px',
		});
		const button = (label: string, command: string) => {
			const btn = append(foot, $('button')) as HTMLButtonElement;
			btn.textContent = label;
			Object.assign(btn.style, {
				padding: '5px 14px', borderRadius: '4px', cursor: 'pointer', fontSize: '12px',
				border: '1px solid var(--vscode-button-border, transparent)',
				background: 'var(--vscode-button-secondaryBackground, rgba(127,127,127,0.2))',
				color: 'var(--vscode-button-secondaryForeground, var(--vscode-foreground))',
			});
			btn.onclick = () => { void this.commandService.executeCommand(command); };
		};
		button('Change project', 'aria.account.changeProject');
		button('Check for updates', 'aria.account.checkUpdates');
	}

	override clearInput(): void {
		this.sectionStore.clear();
		this.sections = [];
		if (this.column) {
			while (this.column.childElementCount > 1) { this.column.removeChild(this.column.lastElementChild!); }
		}
		super.clearInput();
	}

	override focus(): void {
		super.focus();
		this.column?.focus();
	}

	override layout(_dimension: Dimension): void {
		// Content is centered/max-width and scrolls on its own; nothing to size here.
	}
}
