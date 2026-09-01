/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, append, clearNode } from '../../../../../base/browser/dom.js';
import { PROVIDER_LABEL } from '../../../aria/browser/ariaAiProviderChoice.js';
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

		// Plain-language guidance: how to tell if the tools are connected, and what
		// the per-assistant Reconnect button is for.
		const note = append(this.body, $('div'));
		note.textContent = 'If Qoka\'s tools don\'t seem to work, type /mcp in your AI chat to check the connection. If an assistant isn\'t connected (red dot), click its Reconnect tools button.';
		Object.assign(note.style, { fontSize: '12px', opacity: '0.75', margin: '0 0 12px', lineHeight: '1.5' });

		const kindOf = (p: ProviderInfo): 'claude' | 'codex' =>
			(/codex/i.test(p.kind ?? '') || /codex/i.test(p.displayName ?? '')) ? 'codex' : 'claude';

		const buttonStyle = {
			flexShrink: '0', padding: '3px 12px', borderRadius: '4px', cursor: 'pointer', fontSize: '11px',
			border: '1px solid var(--vscode-button-border, transparent)',
			background: 'var(--vscode-button-background)', color: 'var(--vscode-button-foreground)',
		};

		for (const p of providers) {
			const installed = !!p.installed;
			const active = !!p.active;
			const kind = kindOf(p);
			const row = append(this.body, $('div'));
			Object.assign(row.style, { display: 'flex', alignItems: 'center', gap: '8px', margin: '5px 0' });

			// Status dot: green when the assistant is active (connected), red otherwise.
			const dot = append(row, $('span'));
			Object.assign(dot.style, {
				width: '8px', height: '8px', borderRadius: '50%', flexShrink: '0',
				background: active ? 'var(--vscode-charts-green, #4caf50)' : 'var(--vscode-charts-red, #f14c4c)',
			});

			const name = append(row, $('span'));
			// Use the same canonical labels as the provider picker ("Claude Code" /
			// "OpenAI Codex (ChatGPT)") so Settings and the picker read identically.
			name.textContent = PROVIDER_LABEL[kind] ?? p.displayName ?? p.kind ?? 'AI assistant';
			Object.assign(name.style, { flex: '1', minWidth: '0' });

			if (installed) {
				// Installed: a Reconnect tools button that re-registers THIS assistant's MCP.
				const reconnect = append(row, $('button')) as HTMLButtonElement;
				reconnect.textContent = 'Reconnect tools';
				Object.assign(reconnect.style, buttonStyle);
				reconnect.onclick = () => { void this.commandService.executeCommand('aria.mcp.reconnect', [kind]); };
			} else {
				// Not installed: an Install button. The full setup installs the CLI and
				// registers every Qoka MCP with it, then opens the chat extension.
				const install = append(row, $('button')) as HTMLButtonElement;
				install.textContent = 'Install';
				Object.assign(install.style, buttonStyle);
				install.onclick = () => { void this.commandService.executeCommand('aria.setup.installProvider', kind); };
			}
		}
	}
}
