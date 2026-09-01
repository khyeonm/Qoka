/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, append, clearNode } from '../../../../../base/browser/dom.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { SettingsSection } from './settingsSection.js';

/** Mirror of the extension's ResultViewerRow (commands pass plain objects). */
interface ResultViewerRow {
	name: string;
	description: string;
	extensions: string[];
	author: string;
	hubVersion: string | null;
	installedVersion: string | null;
	isDefault: boolean;
	isPipeline: boolean;
	installed: boolean;
	removed: boolean;
}

function primaryButton(btn: HTMLButtonElement): void {
	Object.assign(btn.style, {
		padding: '4px 12px', borderRadius: '4px', cursor: 'pointer', fontSize: '12px',
		border: '1px solid var(--vscode-button-border, transparent)',
		background: 'var(--vscode-button-background)', color: 'var(--vscode-button-foreground)',
	});
}
function secondaryButton(btn: HTMLButtonElement): void {
	Object.assign(btn.style, {
		padding: '4px 12px', borderRadius: '4px', cursor: 'pointer', fontSize: '12px',
		border: '1px solid var(--vscode-button-border, transparent)',
		background: 'var(--vscode-button-secondaryBackground, rgba(127,127,127,0.2))',
		color: 'var(--vscode-button-secondaryForeground, var(--vscode-foreground))',
	});
}

/**
 * Result Viewer section: the file viewers that open result files by type. Default
 * viewers are installed automatically; the user can remove any (its files then open
 * in VS Code's default editor or an installed extension) and install more from the
 * Hub, including viewers shared by other users. Backed by the extension commands
 * `aria.resultViewer.list` / `install` / `remove` / `refresh`.
 */
export class ResultViewerSection extends SettingsSection {

	constructor(body: HTMLElement, commandService: ICommandService, header?: HTMLElement) {
		super(body, commandService, header);
		this.addHeaderAction('codicon-refresh', 'Refresh the viewer list', () => { void this.refresh(); });
	}

	async refresh(): Promise<void> {
		clearNode(this.body);

		const intro = append(this.body, $('div'));
		intro.textContent = 'Viewers that open result files by type. Default viewers are installed for you; remove any you do not want (its files then open in VS Code or an installed extension). Install more from the Hub, including ones shared by other users.';
		Object.assign(intro.style, { fontSize: '11px', opacity: '0.7', margin: '0 0 10px' });

		let rows: ResultViewerRow[] = [];
		let failed = false;
		try {
			rows = (await this.commandService.executeCommand<ResultViewerRow[]>('aria.resultViewer.list')) ?? [];
		} catch {
			failed = true;
		}

		if (failed) {
			const err = append(this.body, $('div'));
			err.textContent = 'Could not load the viewer list (still starting up, or the Hub is unreachable). Use the refresh button to retry.';
			Object.assign(err.style, { fontSize: '11px', opacity: '0.7' });
			return;
		}
		if (!rows.length) {
			const empty = append(this.body, $('div'));
			empty.textContent = 'No viewers found.';
			Object.assign(empty.style, { fontSize: '11px', opacity: '0.7' });
			return;
		}

		for (const row of rows) {
			const item = append(this.body, $('div'));
			Object.assign(item.style, {
				display: 'flex', alignItems: 'center', gap: '8px', padding: '6px 0',
				borderTop: '1px solid var(--vscode-editorWidget-border, rgba(127,127,127,0.15))',
			});

			const info = append(item, $('div'));
			Object.assign(info.style, { flex: '1', minWidth: '0' });

			const title = append(info, $('div'));
			Object.assign(title.style, { fontSize: '12.5px', fontWeight: '600', display: 'flex', alignItems: 'center', gap: '6px' });
			append(title, $('span')).textContent = row.name;
			for (const tag of [row.isDefault ? 'default' : '', row.isPipeline ? 'pipeline' : ''].filter(Boolean)) {
				const b = append(title, $('span'));
				b.textContent = tag;
				Object.assign(b.style, { fontSize: '10px', opacity: '0.55', fontWeight: '400' });
			}

			const meta = append(info, $('div'));
			const extText = row.isPipeline ? 'pipeline dashboard' : (row.extensions.length ? row.extensions.map(e => `.${e}`).join(' ') : '');
			meta.textContent = [extText, row.description].filter(Boolean).join(' - ');
			Object.assign(meta.style, { fontSize: '11px', opacity: '0.65', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' });

			const btn = append(item, $('button')) as HTMLButtonElement;
			btn.style.flexShrink = '0';
			if (row.installed) {
				btn.textContent = 'Remove';
				secondaryButton(btn);
				btn.onclick = async () => {
					btn.disabled = true;
					try { await this.commandService.executeCommand('aria.resultViewer.remove', row.name); } catch { /* command reports its own error */ }
					await this.refresh();
				};
			} else {
				btn.textContent = 'Install';
				primaryButton(btn);
				btn.onclick = async () => {
					btn.disabled = true;
					btn.textContent = 'Installing…';
					try { await this.commandService.executeCommand('aria.resultViewer.install', row.name); } catch { /* command reports its own error */ }
					await this.refresh();
				};
			}
		}
	}
}
