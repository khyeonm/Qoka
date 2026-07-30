/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, append, clearNode } from '../../../../../base/browser/dom.js';
import { SettingsSection } from './settingsSection.js';

interface ProviderInfo { kind?: string; displayName?: string; installed?: boolean; active?: boolean }
interface StatusShape { providers?: ProviderInfo[] }

/**
 * Providers section: which AI assistants (Claude Code / Codex) Qoka detects, and an
 * Install action for any that are missing. Reuses the Autopipe backend
 * (`aria.autopipe.getStatus`) and the provider installer (`aria.provider.installCli`).
 */
export class ProvidersSection extends SettingsSection {

	async refresh(): Promise<void> {
		clearNode(this.body);
		let providers: ProviderInfo[] = [];
		try {
			const status = await this.commandService.executeCommand<StatusShape>('aria.autopipe.getStatus', true);
			providers = status?.providers ?? [];
		} catch { /* extension still booting */ }

		if (providers.length === 0) {
			const row = append(this.body, $('div'));
			row.textContent = 'Detecting AI assistants...';
			Object.assign(row.style, { opacity: '0.6', fontSize: '12px', padding: '2px 0' });
			return;
		}

		for (const p of providers) {
			const installed = !!p.installed;
			const active = !!p.active;
			const row = append(this.body, $('div'));
			Object.assign(row.style, { display: 'flex', alignItems: 'center', gap: '8px', margin: '5px 0' });

			const dot = append(row, $('span'));
			Object.assign(dot.style, {
				width: '8px', height: '8px', borderRadius: '50%', flexShrink: '0',
				background: installed && active ? 'var(--vscode-charts-green, #4caf50)'
					: installed ? 'var(--vscode-charts-yellow, #e6c200)'
						: 'var(--vscode-charts-red, #f14c4c)',
			});

			const name = append(row, $('span'));
			name.textContent = p.displayName ?? p.kind ?? 'AI assistant';
			Object.assign(name.style, { flex: '1', minWidth: '0' });

			const state = append(row, $('span'));
			state.textContent = !installed ? 'not installed' : active ? 'active' : 'installed, not yet active';
			Object.assign(state.style, { fontSize: '11px', opacity: '0.7', flexShrink: '0' });

			if (!installed) {
				const arg = /codex/i.test(p.kind ?? '') || /codex/i.test(p.displayName ?? '') ? 'codex' : 'claude';
				const install = append(row, $('button')) as HTMLButtonElement;
				install.textContent = 'Install';
				Object.assign(install.style, {
					flexShrink: '0', padding: '3px 12px', borderRadius: '4px', cursor: 'pointer', fontSize: '11px',
					border: '1px solid var(--vscode-button-border, transparent)',
					background: 'var(--vscode-button-background)', color: 'var(--vscode-button-foreground)',
				});
				install.onclick = async () => {
					install.textContent = 'Installing...';
					install.disabled = true;
					try { await this.commandService.executeCommand('aria.provider.installCli', arg); } catch { /* surfaced by the command */ }
					await this.refresh();
				};
			}
		}
	}
}
