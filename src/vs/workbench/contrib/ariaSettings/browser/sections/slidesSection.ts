/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, append, clearNode } from '../../../../../base/browser/dom.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { SettingsSection } from './settingsSection.js';

/**
 * Slides section: a way back into the Slides onboarding for a user whose AI has lost its
 * whirick connection. Decks are made by asking the AI (through the whirick slide app), so
 * there is no key or server to manage here; the one action re-opens the setup guide, which
 * walks Claude / Codex through reconnecting.
 */
export class SlidesSection extends SettingsSection {

	constructor(body: HTMLElement, commandService: ICommandService, header?: HTMLElement) {
		super(body, commandService, header);
	}

	async refresh(): Promise<void> {
		clearNode(this.body);

		const note = append(this.body, $('div'));
		note.textContent = 'Slides are created by asking the AI in the chat, through the whirick slide app. If the AI is no longer connected to the slide app, reopen the setup guide to reconnect it.';
		Object.assign(note.style, { fontSize: '11px', opacity: '0.7', margin: '0 0 10px', lineHeight: '1.5' });

		const row = append(this.body, $('div'));
		Object.assign(row.style, { display: 'flex', justifyContent: 'flex-end' });
		const btn = append(row, $('button')) as HTMLButtonElement;
		btn.textContent = 'Show setup guide';
		Object.assign(btn.style, {
			padding: '5px 14px', borderRadius: '4px', cursor: 'pointer', fontSize: '12px', border: 'none',
			background: 'var(--vscode-button-background)', color: 'var(--vscode-button-foreground)',
			fontFamily: 'var(--vscode-font-family, system-ui, sans-serif)',
		});
		btn.onclick = () => { void this.commandService.executeCommand('qoka.slides.showSetupGuide'); };
	}
}
