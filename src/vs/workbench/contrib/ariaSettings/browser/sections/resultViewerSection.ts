/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, append, clearNode } from '../../../../../base/browser/dom.js';
import { URI } from '../../../../../base/common/uri.js';
import { SettingsSection } from './settingsSection.js';

/** Autopipe's viewer-plugin authoring guide. */
const PLUGIN_GUIDE_URL = 'https://autopipe.org/plugins/guide';

function primaryButton(btn: HTMLButtonElement): void {
	Object.assign(btn.style, {
		padding: '5px 14px', borderRadius: '4px', cursor: 'pointer', fontSize: '12px',
		border: '1px solid var(--vscode-button-border, transparent)',
		background: 'var(--vscode-button-background)', color: 'var(--vscode-button-foreground)',
	});
}
function secondaryButton(btn: HTMLButtonElement): void {
	Object.assign(btn.style, {
		padding: '5px 14px', borderRadius: '4px', cursor: 'pointer', fontSize: '12px',
		border: '1px solid var(--vscode-button-border, transparent)',
		background: 'var(--vscode-button-secondaryBackground, rgba(127,127,127,0.2))',
		color: 'var(--vscode-button-secondaryForeground, var(--vscode-foreground))',
	});
}

/**
 * Result Viewer section: a short blurb plus two actions - "Manage Result Viewers"
 * opens the panel where the user installs / removes viewers (including ones shared
 * by other users), and "Create a viewer plugin" opens Autopipe's authoring guide.
 * The full list lives in the panel so the Settings page stays short.
 */
export class ResultViewerSection extends SettingsSection {

	async refresh(): Promise<void> {
		clearNode(this.body);

		const note = append(this.body, $('div'));
		note.textContent = 'File viewers that open result files by type. Default viewers are installed for you; install more (including ones shared by other users), remove any you do not want, or build your own.';
		Object.assign(note.style, { fontSize: '11px', opacity: '0.7', margin: '0 0 10px' });

		const row = append(this.body, $('div'));
		Object.assign(row.style, { display: 'flex', gap: '8px', flexWrap: 'wrap', justifyContent: 'flex-end' });

		const manage = append(row, $('button')) as HTMLButtonElement;
		manage.textContent = 'Manage Result Viewers';
		primaryButton(manage);
		manage.onclick = () => { void this.commandService.executeCommand('aria.autopipe.openPlugins'); };

		const create = append(row, $('button')) as HTMLButtonElement;
		create.textContent = 'Create a viewer plugin';
		secondaryButton(create);
		create.title = PLUGIN_GUIDE_URL;
		create.onclick = () => { void this.commandService.executeCommand('vscode.open', URI.parse(PLUGIN_GUIDE_URL)); };
	}
}
