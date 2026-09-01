/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, append, clearNode } from '../../../../../base/browser/dom.js';
import { SettingsSection } from './settingsSection.js';

function primaryButton(btn: HTMLButtonElement): void {
	Object.assign(btn.style, {
		padding: '5px 14px', borderRadius: '4px', cursor: 'pointer', fontSize: '12px',
		border: '1px solid var(--vscode-button-border, transparent)',
		background: 'var(--vscode-button-background)', color: 'var(--vscode-button-foreground)',
	});
}

/**
 * Result Viewer section: a short blurb plus a button that opens the Result Viewers
 * panel, where the user installs / removes viewers (including ones shared by other
 * users) with search and refresh. The list lives in the panel, not here, so the
 * Settings page stays short.
 */
export class ResultViewerSection extends SettingsSection {

	async refresh(): Promise<void> {
		clearNode(this.body);

		const note = append(this.body, $('div'));
		note.textContent = 'File viewers that open result files by type. Default viewers are installed for you; manage them - install more (including ones shared by other users), remove any you do not want - in the Result Viewers panel.';
		Object.assign(note.style, { fontSize: '11px', opacity: '0.7', margin: '0 0 10px' });

		const btn = append(this.body, $('button')) as HTMLButtonElement;
		btn.textContent = 'Manage Result Viewers';
		primaryButton(btn);
		btn.onclick = () => { void this.commandService.executeCommand('aria.autopipe.openPlugins'); };
	}
}
