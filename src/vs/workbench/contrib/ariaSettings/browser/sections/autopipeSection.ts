/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, append, clearNode } from '../../../../../base/browser/dom.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { ariaHelpActionId } from '../../../aria/browser/ariaHelpEditor.js';
import { SettingsSection } from './settingsSection.js';

interface AutopipeStatus {
	githubConnected?: boolean;
	githubLogin?: string;
	uploadMode?: 'per-pipeline' | 'single';
	uploadRepoName?: string;
}

function primaryButton(btn: HTMLButtonElement): void {
	Object.assign(btn.style, {
		padding: '5px 14px', borderRadius: '4px', cursor: 'pointer', fontSize: '12px',
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
 * Autopipe section: GitHub connection (needed to upload pipelines), the pipeline
 * upload mode, and the Pipeline Hub / Plugins entry points. Reuses the Autopipe
 * backend commands (`aria.autopipe.github.*`, `aria.autopipe.repo.*`,
 * `aria.autopipe.openHub` / `openPlugins`).
 */
export class AutopipeSection extends SettingsSection {

	constructor(body: HTMLElement, commandService: ICommandService, header?: HTMLElement) {
		super(body, commandService, header);
		this.addHeaderTextAction('How to use?', 'How to use Autopipe', () => {
			void this.commandService.executeCommand(ariaHelpActionId('autopipe'));
		});
	}

	async refresh(): Promise<void> {
		clearNode(this.body);
		let status: AutopipeStatus = {};
		try { status = (await this.commandService.executeCommand<AutopipeStatus>('aria.autopipe.getStatus', true)) ?? {}; } catch { /* booting */ }

		// --- GitHub ---
		const gh = append(this.body, $('div'));
		if (status.githubConnected) {
			const row = append(gh, $('div'));
			Object.assign(row.style, { display: 'flex', alignItems: 'center', gap: '8px', margin: '3px 0' });
			const dot = append(row, $('span'));
			Object.assign(dot.style, { width: '8px', height: '8px', borderRadius: '50%', flexShrink: '0', background: 'var(--vscode-charts-green, #4caf50)' });
			const text = append(row, $('span'));
			text.textContent = status.githubLogin ? `GitHub: connected as @${status.githubLogin}` : 'GitHub: connected';
			Object.assign(text.style, { flex: '1', minWidth: '0' });
			const signOut = append(row, $('button')) as HTMLButtonElement;
			signOut.textContent = 'Sign out';
			secondaryButton(signOut);
			signOut.onclick = async () => {
				try { await this.commandService.executeCommand('aria.autopipe.github.logout'); } catch { /* command shows its own error */ }
				await this.refresh();
			};
		} else {
			const row = append(gh, $('div'));
			Object.assign(row.style, { display: 'flex', alignItems: 'center', gap: '8px', margin: '3px 0' });
			const dot = append(row, $('span'));
			Object.assign(dot.style, { width: '8px', height: '8px', borderRadius: '50%', flexShrink: '0', background: 'var(--vscode-charts-yellow, #e6c200)' });
			const text = append(row, $('span'));
			text.textContent = 'GitHub: not connected - needed to upload pipelines';
			Object.assign(text.style, { flex: '1', minWidth: '0' });
			// Connect button pinned to the right end of the row (same spot as Sign out).
			const btn = append(row, $('button')) as HTMLButtonElement;
			btn.textContent = 'Connect to GitHub';
			primaryButton(btn);
			btn.style.flexShrink = '0';
			btn.onclick = async () => {
				try { await this.commandService.executeCommand('aria.autopipe.github.login'); } catch { /* handled */ }
				await this.refresh();
			};
		}

		// --- Upload mode ---
		const subHeader = append(this.body, $('div'));
		subHeader.textContent = 'Pipeline upload mode';
		Object.assign(subHeader.style, { marginTop: '16px', fontSize: '11.5px', fontWeight: '600', opacity: '0.9' });
		const note = append(this.body, $('div'));
		note.textContent = 'Whether each pipeline gets its own GitHub repo, or all share one.';
		Object.assign(note.style, { fontSize: '11px', opacity: '0.7', margin: '4px 0 6px' });

		const mode = status.uploadMode ?? 'per-pipeline';
		const modeRow = append(this.body, $('div'));
		Object.assign(modeRow.style, { display: 'flex', gap: '14px', fontSize: '12px', marginTop: '2px' });

		// The shared-repo name field is built once and shown/hidden as the mode toggles,
		// so switching modes changes only the selection - it does NOT rebuild the section.
		const repoWrap = append(this.body, $('div'));
		repoWrap.style.display = mode === 'single' ? 'block' : 'none';
		const repoLabel = append(repoWrap, $('div'));
		repoLabel.textContent = 'Shared GitHub repo name';
		Object.assign(repoLabel.style, { fontSize: '11px', opacity: '0.85', marginTop: '8px' });
		const repoInput = append(repoWrap, $('input')) as HTMLInputElement;
		repoInput.type = 'text';
		repoInput.value = status.uploadRepoName ?? '';
		repoInput.placeholder = 'aria-pipelines';
		Object.assign(repoInput.style, { width: '100%', boxSizing: 'border-box', padding: '4px 6px', fontSize: '12px', marginTop: '2px' });
		repoInput.onchange = () => { void this.commandService.executeCommand('aria.autopipe.repo.setRepoName', repoInput.value.trim()); };

		for (const opt of [{ value: 'per-pipeline' as const, label: 'Per-pipeline repo' }, { value: 'single' as const, label: 'Single shared repo' }]) {
			const wrap = append(modeRow, $('label'));
			Object.assign(wrap.style, { display: 'flex', alignItems: 'center', gap: '5px', cursor: 'pointer' });
			const radio = append(wrap, $('input')) as HTMLInputElement;
			radio.type = 'radio';
			radio.name = 'aria-settings-upload-mode';
			radio.checked = mode === opt.value;
			radio.onchange = () => {
				if (!radio.checked) { return; }
				// Persist the choice and toggle the repo field in place - no re-render.
				repoWrap.style.display = opt.value === 'single' ? 'block' : 'none';
				void this.commandService.executeCommand('aria.autopipe.repo.setModeValue', opt.value);
			};
			append(wrap, $('span')).textContent = opt.label;
		}

		// --- Discover ---
		const discoverHeader = append(this.body, $('div'));
		discoverHeader.textContent = 'Discover';
		Object.assign(discoverHeader.style, { marginTop: '16px', fontSize: '11.5px', fontWeight: '600', opacity: '0.9', marginBottom: '6px' });
		const discoverRow = append(this.body, $('div'));
		Object.assign(discoverRow.style, { display: 'flex', gap: '8px' });
		const hub = append(discoverRow, $('button')) as HTMLButtonElement;
		hub.textContent = 'Pipeline Hub';
		primaryButton(hub); hub.style.flex = '1';
		hub.onclick = () => { void this.commandService.executeCommand('aria.autopipe.openHub'); };
		const plugins = append(discoverRow, $('button')) as HTMLButtonElement;
		plugins.textContent = 'Plugins';
		primaryButton(plugins); plugins.style.flex = '1';
		plugins.onclick = () => { void this.commandService.executeCommand('aria.autopipe.openPlugins'); };
	}
}
