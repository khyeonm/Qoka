/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, append, clearNode } from '../../../../../base/browser/dom.js';
import { SettingsSection } from './settingsSection.js';

interface BioRenderStatus { connected?: boolean; account?: string }

function primaryButton(btn: HTMLButtonElement): void {
	Object.assign(btn.style, {
		flexShrink: '0', padding: '5px 14px', borderRadius: '4px', cursor: 'pointer', fontSize: '12px',
		border: '1px solid var(--vscode-button-border, transparent)',
		background: 'var(--vscode-button-background)', color: 'var(--vscode-button-foreground)',
	});
}
function secondaryButton(btn: HTMLButtonElement): void {
	Object.assign(btn.style, {
		flexShrink: '0', padding: '5px 14px', borderRadius: '4px', cursor: 'pointer', fontSize: '12px',
		border: '1px solid var(--vscode-button-border, transparent)',
		background: 'var(--vscode-button-secondaryBackground, rgba(127,127,127,0.2))',
		color: 'var(--vscode-button-secondaryForeground, var(--vscode-foreground))',
	});
}

/**
 * BioRender section: connect the user's own BioRender account so the chat can
 * search icons/templates and generate figures as that account. The BioRender MCP
 * is a built-in Qoka server; only the login lives here. Login runs Qoka's own
 * OAuth (loopback) via `aria.biorender.login`, which injects the token into the
 * AI CLIs - the `/mcp` flow is never needed.
 */
export class BioRenderSection extends SettingsSection {

	async refresh(): Promise<void> {
		clearNode(this.body);

		const note = append(this.body, $('div'));
		note.textContent = 'Connect your BioRender account to search icons and templates and generate figures from chat. Login opens BioRender in your browser once; Qoka never sees your password.';
		Object.assign(note.style, { fontSize: '11px', opacity: '0.7', margin: '0 0 10px', lineHeight: '1.5' });

		let status: BioRenderStatus = {};
		try { status = (await this.commandService.executeCommand<BioRenderStatus>('aria.biorender.getStatus')) ?? {}; } catch { /* extension booting */ }

		const row = append(this.body, $('div'));
		Object.assign(row.style, { display: 'flex', alignItems: 'center', gap: '8px', margin: '3px 0' });
		const dot = append(row, $('span'));
		Object.assign(dot.style, {
			width: '8px', height: '8px', borderRadius: '50%', flexShrink: '0',
			background: status.connected ? 'var(--vscode-charts-green, #4caf50)' : 'var(--vscode-charts-yellow, #e6c200)',
		});
		const text = append(row, $('span'));
		Object.assign(text.style, { flex: '1', minWidth: '0' });

		if (status.connected) {
			text.textContent = status.account ? `BioRender: connected as ${status.account}` : 'BioRender: connected';
			const logout = append(row, $('button')) as HTMLButtonElement;
			logout.textContent = 'Disconnect';
			secondaryButton(logout);
			logout.onclick = async () => {
				logout.disabled = true;
				try { await this.commandService.executeCommand('aria.biorender.logout'); } catch { /* handled */ }
				await this.refresh();
			};
		} else {
			text.textContent = 'BioRender: not connected';
			const login = append(row, $('button')) as HTMLButtonElement;
			login.textContent = 'Connect to BioRender';
			primaryButton(login);
			login.onclick = async () => {
				login.disabled = true;
				login.textContent = 'Connecting...';
				try {
					const r = await this.commandService.executeCommand<{ ok?: boolean; message?: string }>('aria.biorender.login');
					if (r && r.ok === false && r.message) {
						const err = append(this.body, $('div'));
						err.textContent = r.message;
						Object.assign(err.style, { fontSize: '11px', color: 'var(--vscode-errorForeground)', marginTop: '6px' });
					}
				} catch { /* handled */ }
				await this.refresh();
			};
		}
	}
}
