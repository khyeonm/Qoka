/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, append, clearNode } from '../../../../../base/browser/dom.js';
import { URI } from '../../../../../base/common/uri.js';
import { SettingsSection } from './settingsSection.js';

interface PenpotStatus { connected?: boolean; serverUrl?: string; keyMask?: string }

/**
 * Penpot section: connect Penpot (open-source editable-vector design tool) so the chat
 * can draw publication figures via its MCP. This replaces the removed BioRender
 * integration. Penpot authenticates the MCP with a personal MCP KEY (no OAuth), which
 * Qoka stores and injects into the MCP URL. Connect opens a step-by-step wizard that
 * stays on screen while the user visits Penpot in the browser (so the instructions are
 * never lost), collects the key, and registers the MCP for Claude and Codex.
 *
 * Two facts the user must know are pinned as persistent notices: (1) a NEW chat must be
 * opened after connecting for the registration to take effect, and (2) a Penpot design
 * file must be OPEN and connected (File -> MCP Server -> Connect) for drawing to work.
 */
export class PenpotSection extends SettingsSection {

	private dot: HTMLElement | undefined;
	private label: HTMLElement | undefined;
	private button: HTMLButtonElement | undefined;
	private keyRow: HTMLElement | undefined;
	private keyInput: HTMLInputElement | undefined;
	private errEl: HTMLElement | undefined;
	private busy = false;
	private serverUrl = 'https://design.penpot.app';
	private currentMask = '';

	async refresh(): Promise<void> {
		clearNode(this.body);
		this.busy = false;

		const note = append(this.body, $('div'));
		note.textContent = 'Connect Penpot (an open-source, editable-vector design tool) so the chat can draw publication figures. Qoka stores your Penpot MCP key and registers it for Claude and Codex; no password is ever seen.';
		Object.assign(note.style, { fontSize: '11px', opacity: '0.7', margin: '0 0 10px', lineHeight: '1.5' });

		// Persistent notice 1: a new chat is required after connecting. Leading "*" red.
		this.starNotice('After connecting Penpot, you MUST open a new Claude or Codex chat (or reload Qoka) for it to take effect. A chat already open will not see Penpot.');
		// Persistent notice 2: a file must be open + connected to draw.
		this.starNotice('In Penpot, a design file must be OPEN and connected (File -> MCP Server -> Connect) for drawing to work. Check the MCP indicator at the top of the file to confirm it is active.');

		// Status row (built once; connect/disconnect update it in place).
		const row = append(this.body, $('div'));
		Object.assign(row.style, { display: 'flex', alignItems: 'center', gap: '8px', margin: '12px 0 3px' });
		const dot = append(row, $('span'));
		Object.assign(dot.style, { width: '8px', height: '8px', borderRadius: '50%', flexShrink: '0' });
		this.dot = dot;
		const label = append(row, $('span'));
		Object.assign(label.style, { flex: '1', minWidth: '0' });
		this.label = label;
		const button = append(row, $('button')) as HTMLButtonElement;
		this.button = button;

		// Stored key display: masked but editable, with a Save button (shown only when
		// connected). Editing the value and pressing Save re-registers with the new key.
		const keyRow = append(this.body, $('div'));
		Object.assign(keyRow.style, { display: 'flex', alignItems: 'center', gap: '6px', margin: '8px 0 0' });
		this.keyRow = keyRow;
		const keyLabel = append(keyRow, $('span'));
		keyLabel.textContent = 'MCP key:';
		Object.assign(keyLabel.style, { fontSize: '11px', opacity: '0.7', flexShrink: '0' });
		const keyInput = append(keyRow, $('input')) as HTMLInputElement;
		keyInput.type = 'text';
		keyInput.spellcheck = false;
		Object.assign(keyInput.style, {
			flex: '1', minWidth: '0', fontSize: '12px', padding: '4px 8px', borderRadius: '4px',
			border: '1px solid var(--vscode-input-border, rgba(127,127,127,0.4))',
			background: 'var(--vscode-input-background)', color: 'var(--vscode-input-foreground)',
		});
		this.keyInput = keyInput;
		const saveBtn = append(keyRow, $('button')) as HTMLButtonElement;
		saveBtn.textContent = 'Save';
		this.secondaryButton(saveBtn);
		saveBtn.onclick = () => void this.saveEditedKey();
		keyRow.hidden = true;

		this.errEl = append(this.body, $('div'));
		Object.assign(this.errEl.style, { fontSize: '11px', color: 'var(--vscode-errorForeground)', marginTop: '6px' });
		this.errEl.hidden = true;

		this.apply({ connected: false }, true);
		void this.loadAndApply();
	}

	/** A bordered notice box whose leading "*" is red and the rest uses the note colour. */
	private starNotice(text: string): void {
		const box = append(this.body, $('div'));
		Object.assign(box.style, {
			fontSize: '11px', lineHeight: '1.5', marginTop: '8px', padding: '8px 10px', borderRadius: '4px',
			border: '1px solid var(--vscode-panel-border, rgba(127,127,127,0.35))',
		});
		const star = append(box, $('span'));
		star.textContent = '* ';
		Object.assign(star.style, { color: 'var(--vscode-errorForeground)' });
		const body = append(box, $('span'));
		body.textContent = text;
		Object.assign(body.style, { opacity: '0.7' });
	}

	private async loadAndApply(): Promise<void> {
		let status: PenpotStatus = { connected: false };
		try { status = (await this.commandService.executeCommand<PenpotStatus>('aria.penpot.getStatus')) ?? { connected: false }; } catch { /* offline */ }
		if (status.serverUrl) { this.serverUrl = status.serverUrl; }
		this.currentMask = status.keyMask ?? '';
		this.apply(status, false);
	}

	private apply(status: PenpotStatus, checking: boolean): void {
		const dot = this.dot, label = this.label, button = this.button, keyRow = this.keyRow, keyInput = this.keyInput;
		if (!dot || !label || !button || !keyRow || !keyInput) { return; }
		if (checking) {
			dot.style.background = 'var(--vscode-charts-yellow, #e6c200)';
			label.textContent = 'Penpot: checking...';
			button.hidden = true;
			keyRow.hidden = true;
			return;
		}
		button.hidden = false;
		if (status.connected) {
			dot.style.background = 'var(--vscode-charts-green, #4caf50)';
			label.textContent = 'Penpot: connected';
			button.textContent = 'Disconnect';
			this.secondaryButton(button);
			button.disabled = false;
			button.onclick = () => void this.disconnect();
			keyRow.hidden = false;
			keyInput.value = status.keyMask ?? '';
		} else {
			dot.style.background = 'var(--vscode-charts-yellow, #e6c200)';
			label.textContent = 'Penpot: not connected';
			button.textContent = 'Connect Penpot';
			this.primaryButton(button);
			button.disabled = false;
			button.onclick = () => this.openWizard();
			keyRow.hidden = true;
		}
	}

	private async disconnect(): Promise<void> {
		if (this.busy) { return; }
		this.busy = true;
		if (this.errEl) { this.errEl.hidden = true; }
		if (this.button) { this.button.disabled = true; this.button.textContent = 'Disconnecting...'; }
		try { await this.commandService.executeCommand('aria.penpot.disconnect'); } catch { /* handled by refresh */ }
		this.busy = false;
		await this.loadAndApply();
	}

	/** Save an edited key from the section's masked field. If the value is unchanged
	 *  (still the mask) do nothing; otherwise re-connect with the new key. */
	private async saveEditedKey(): Promise<void> {
		const input = this.keyInput;
		if (!input || this.busy) { return; }
		const value = input.value.trim();
		if (!value || value === this.currentMask) { return; }
		this.busy = true;
		if (this.errEl) { this.errEl.hidden = true; }
		try {
			const r = await this.commandService.executeCommand<{ ok?: boolean; message?: string }>('aria.penpot.connect', { key: value, serverUrl: this.serverUrl });
			if (r && r.ok === false && this.errEl) { this.errEl.textContent = r.message ?? 'Failed to save key.'; this.errEl.hidden = false; }
		} catch { /* handled by refresh */ }
		this.busy = false;
		await this.loadAndApply();
	}

	// --- Connect wizard (stays on screen while the user visits Penpot) ---

	private openWizard(): void {
		const doc = this.body.ownerDocument;
		const overlay = append(doc.body, $('div'));
		Object.assign(overlay.style, {
			position: 'fixed', inset: '0', zIndex: '10000', display: 'flex', alignItems: 'center', justifyContent: 'center',
			background: 'rgba(0,0,0,0.45)',
		});
		const panel = append(overlay, $('div'));
		Object.assign(panel.style, {
			width: 'min(560px, 92vw)', maxHeight: '86vh', overflowY: 'auto', boxSizing: 'border-box',
			background: 'var(--vscode-editor-background)', color: 'var(--vscode-foreground)',
			border: '1px solid var(--vscode-widget-border, rgba(127,127,127,0.35))', borderRadius: '8px',
			padding: '20px 22px', boxShadow: '0 8px 40px rgba(0,0,0,0.4)', fontSize: '13px', lineHeight: '1.55',
		});
		const close = () => { try { doc.body.removeChild(overlay); } catch { /* noop */ } };
		overlay.onclick = (e) => { if (e.target === overlay) { close(); } };

		let step = 1;
		let key = '';
		let server = this.serverUrl;

		const render = () => {
			clearNode(panel);
			// Header
			const head = append(panel, $('div'));
			Object.assign(head.style, { display: 'flex', alignItems: 'center', marginBottom: '4px' });
			const title = append(head, $('div'));
			title.textContent = `Connect Penpot  -  Step ${step} of 3`;
			Object.assign(title.style, { fontWeight: '700', fontSize: '14px' });
			const x = append(head, $('span.codicon.codicon-close')) as HTMLElement;
			Object.assign(x.style, { marginLeft: 'auto', cursor: 'pointer', opacity: '0.7' });
			x.onclick = close;

			if (step === 1) {
				this.p(panel, 'Overview: (1) generate a key in Penpot, (2) paste it here, (3) open a file and connect it. This window stays open while you visit Penpot, so you can follow along.');
				const openBtn = append(panel, $('button')) as HTMLButtonElement;
				openBtn.textContent = 'Open Penpot';
				this.primaryButton(openBtn);
				Object.assign(openBtn.style, { margin: '10px 0' });
				openBtn.onclick = () => void this.commandService.executeCommand('vscode.open', URI.parse(server));
				this.steps(panel, 'In the Penpot browser tab:', [
					'Log in (or create a free account).',
					'Top-right account menu -> Integrations -> MCP Server.',
					'Enable it and click Generate key.',
					'Copy the key (it is shown only once).',
				]);
				const hint = append(panel, $('div'));
				hint.textContent = 'Lost the tab? Click "Open Penpot" again. Then come back here and press Next.';
				Object.assign(hint.style, { fontSize: '11px', opacity: '0.6', marginTop: '8px' });
				this.nav(panel, close, () => { step = 2; render(); }, 'Next');
			} else if (step === 2) {
				this.p(panel, 'Paste the MCP key you copied from Penpot.');
				const input = append(panel, $('input')) as HTMLInputElement;
				input.type = 'text'; input.spellcheck = false; input.placeholder = 'Penpot MCP key';
				input.value = key;
				this.field(input);
				input.oninput = () => { key = input.value; };
				const advLabel = append(panel, $('div'));
				advLabel.textContent = 'Penpot server (change only for self-hosted):';
				Object.assign(advLabel.style, { fontSize: '11px', opacity: '0.6', margin: '10px 0 4px' });
				const srv = append(panel, $('input')) as HTMLInputElement;
				srv.type = 'text'; srv.spellcheck = false; srv.value = server;
				this.field(srv);
				srv.oninput = () => { server = srv.value; };
				const err = append(panel, $('div'));
				Object.assign(err.style, { fontSize: '11px', color: 'var(--vscode-errorForeground)', marginTop: '8px' });
				err.hidden = true;
				this.nav(panel, () => { step = 1; render(); }, async () => {
					if (!key.trim()) { err.textContent = 'Enter your Penpot MCP key.'; err.hidden = false; return; }
					err.hidden = true;
					try {
						const r = await this.commandService.executeCommand<{ ok?: boolean; message?: string }>('aria.penpot.connect', { key: key.trim(), serverUrl: server.trim() });
						if (r && r.ok === false) { err.textContent = r.message ?? 'Connect failed.'; err.hidden = false; return; }
					} catch (e) { err.textContent = 'Connect failed.'; err.hidden = false; return; }
					step = 3; render();
					void this.loadAndApply();
				}, 'Connect', 'Back');
			} else {
				const ok = append(panel, $('div'));
				ok.textContent = 'Penpot is connected.';
				Object.assign(ok.style, { color: 'var(--vscode-charts-green, #4caf50)', fontWeight: '700', margin: '4px 0 8px' });
				this.steps(panel, 'To start drawing:', [
					'Open a NEW Claude or Codex chat (or reload Qoka) so the tool is registered.',
					'In Penpot, open (or create) a design file.',
					'In that file: File -> MCP Server -> Connect.',
					'Confirm the MCP indicator at the top of the file is active (green).',
					'Keep the file open, then ask the chat to draw (e.g. "draw a signaling pathway in penpot").',
				]);
				const warn = append(panel, $('div'));
				warn.textContent = 'The file must stay open and connected while you use Penpot from chat.';
				Object.assign(warn.style, { fontSize: '11px', opacity: '0.7', marginTop: '8px' });
				const done = append(panel, $('button')) as HTMLButtonElement;
				done.textContent = 'Done';
				this.primaryButton(done);
				Object.assign(done.style, { marginTop: '14px' });
				done.onclick = close;
			}
		};
		render();
	}

	// --- small DOM helpers ---

	private p(parent: HTMLElement, text: string): void {
		const el = append(parent, $('div'));
		el.textContent = text;
		Object.assign(el.style, { margin: '8px 0', opacity: '0.85' });
	}

	private steps(parent: HTMLElement, title: string, items: string[]): void {
		const t = append(parent, $('div'));
		t.textContent = title;
		Object.assign(t.style, { fontWeight: '600', margin: '10px 0 6px' });
		const ol = append(parent, $('ol'));
		Object.assign(ol.style, { margin: '0', paddingLeft: '20px', opacity: '0.9' });
		for (const it of items) {
			const li = append(ol, $('li'));
			li.textContent = it;
			Object.assign(li.style, { margin: '3px 0' });
		}
	}

	private field(input: HTMLInputElement): void {
		Object.assign(input.style, {
			width: '100%', boxSizing: 'border-box', fontSize: '12px', padding: '6px 8px', borderRadius: '4px',
			border: '1px solid var(--vscode-input-border, rgba(127,127,127,0.4))',
			background: 'var(--vscode-input-background)', color: 'var(--vscode-input-foreground)',
		});
	}

	private nav(parent: HTMLElement, back: () => void, next: () => void, nextText: string, backText = 'Cancel'): void {
		const bar = append(parent, $('div'));
		Object.assign(bar.style, { display: 'flex', gap: '8px', justifyContent: 'flex-end', marginTop: '16px' });
		const b = append(bar, $('button')) as HTMLButtonElement;
		b.textContent = backText;
		this.secondaryButton(b);
		b.onclick = back;
		const n = append(bar, $('button')) as HTMLButtonElement;
		n.textContent = nextText;
		this.primaryButton(n);
		n.onclick = next;
	}

	private primaryButton(btn: HTMLButtonElement): void {
		Object.assign(btn.style, {
			flexShrink: '0', padding: '5px 14px', borderRadius: '4px', cursor: 'pointer', fontSize: '12px',
			border: '1px solid var(--vscode-button-border, transparent)',
			background: 'var(--vscode-button-background)', color: 'var(--vscode-button-foreground)',
		});
	}
	private secondaryButton(btn: HTMLButtonElement): void {
		Object.assign(btn.style, {
			flexShrink: '0', padding: '5px 14px', borderRadius: '4px', cursor: 'pointer', fontSize: '12px',
			border: '1px solid var(--vscode-button-border, transparent)',
			background: 'var(--vscode-button-secondaryBackground, rgba(127,127,127,0.2))',
			color: 'var(--vscode-button-secondaryForeground, var(--vscode-foreground))',
		});
	}
}
