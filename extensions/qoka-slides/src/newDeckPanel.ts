/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The "New slides" popup: a small webview form (title + design + ratio) shown in
// the editor area. On Create it hands the choices back and closes; the caller
// creates the deck and opens the render editor. A dedicated webview (not an
// overlay over the list) so it can never intercept clicks elsewhere.

import * as vscode from 'vscode';
import * as crypto from 'crypto';
import { Aspect } from './storage';

export interface NewDeckChoice { title: string; theme: string; aspect: Aspect; }

export class NewDeckPanel {
	private static current: NewDeckPanel | undefined;
	private readonly panel: vscode.WebviewPanel;
	private readonly disposables: vscode.Disposable[] = [];

	static open(themes: { id: string; name: string }[], onCreate: (c: NewDeckChoice) => void): void {
		if (NewDeckPanel.current) { NewDeckPanel.current.panel.reveal(vscode.ViewColumn.Active); return; }
		const panel = vscode.window.createWebviewPanel('qoka.slides.new', 'New slides', vscode.ViewColumn.Active, {
			enableScripts: true,
			localResourceRoots: [],
		});
		NewDeckPanel.current = new NewDeckPanel(panel, themes, onCreate);
	}

	private constructor(panel: vscode.WebviewPanel, private readonly themes: { id: string; name: string }[], private readonly onCreate: (c: NewDeckChoice) => void) {
		this.panel = panel;
		this.panel.webview.html = this.html();
		this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
		this.panel.webview.onDidReceiveMessage((m) => {
			if (!m) { return; }
			if (m.type === 'create') {
				const title = String(m.title || 'Untitled').trim() || 'Untitled';
				const theme = String(m.theme || (this.themes[0]?.id ?? 'plain'));
				const aspect: Aspect = m.aspect === '4:3' ? '4:3' : '16:9';
				this.onCreate({ title, theme, aspect });
				this.panel.dispose();
			} else if (m.type === 'cancel') {
				this.panel.dispose();
			}
		}, null, this.disposables);
	}

	private html(): string {
		const webview = this.panel.webview;
		const nonce = crypto.randomBytes(16).toString('hex');
		const advanced = vscode.workspace.getConfiguration().get<string>('aria.mode') === 'advanced';
		const accent = advanced ? '' : ':root{--vscode-button-background:#2ba7c9!important;--vscode-button-hoverBackground:#2496b6!important;}';
		const csp = [`default-src 'none'`, `style-src ${webview.cspSource} 'unsafe-inline'`, `script-src 'nonce-${nonce}'`].join('; ');
		const designBtns = (this.themes.length ? this.themes : [{ id: 'plain', name: 'Basic' }, { id: 'crimson', name: 'Crimson' }])
			.map((t, i) => `<button type="button" class="pick${i === 0 ? ' sel' : ''}" data-theme="${escAttr(t.id)}">${escHtml(t.name)}</button>`).join('');
		return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<style>
	${accent}
	html, body { height: 100%; margin: 0; }
	body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); display: flex; align-items: center; justify-content: center; }
	.card { width: 380px; max-width: 88vw; background: var(--vscode-editorWidget-background, var(--vscode-editor-background)); border: 1px solid var(--vscode-widget-border, rgba(128,128,128,.3)); border-radius: 10px; padding: 20px 22px; box-shadow: 0 8px 40px rgba(0,0,0,.35); }
	h2 { margin: 0 0 16px; font-size: 1.05rem; }
	label { display: block; margin-bottom: 14px; }
	.lbl { display: block; margin-bottom: 6px; opacity: .85; font-size: .85rem; }
	input[type=text] { width: 100%; box-sizing: border-box; padding: 7px 9px; border-radius: 5px; border: 1px solid var(--vscode-input-border, rgba(128,128,128,.3)); background: var(--vscode-input-background); color: var(--vscode-input-foreground); font-family: inherit; }
	.picks { display: flex; flex-wrap: wrap; gap: 6px; }
	.pick, .ratio { padding: 5px 12px; border-radius: 5px; cursor: pointer; font-family: inherit; font-size: .85rem; border: 1px solid var(--vscode-contrastBorder, transparent); background: var(--vscode-button-secondaryBackground, rgba(127,127,127,.15)); color: var(--vscode-button-secondaryForeground, var(--vscode-foreground)); }
	.pick.sel, .ratio.sel { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border-color: transparent; }
	.actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 20px; }
	.actions button { padding: 5px 14px; border-radius: 5px; cursor: pointer; font-family: inherit; border: 1px solid var(--vscode-contrastBorder, transparent); background: var(--vscode-button-secondaryBackground, transparent); color: var(--vscode-button-secondaryForeground, var(--vscode-foreground)); }
	#create { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border-color: transparent; }
</style>
</head><body>
<div class="card">
	<h2>New slides</h2>
	<label><span class="lbl">Title</span><input id="title" type="text" value="Untitled" /></label>
	<div class="field"><span class="lbl">Design</span><div class="picks" id="designs">${designBtns}</div></div>
	<div class="field" style="margin-top:14px"><span class="lbl">Ratio</span>
		<div class="picks" id="ratios"><button type="button" class="ratio sel" data-ratio="16:9">16:9</button><button type="button" class="ratio" data-ratio="4:3">4:3</button></div>
	</div>
	<div class="actions"><button id="cancel" type="button">Cancel</button><button id="create" type="button">Create</button></div>
</div>
<script nonce="${nonce}">
(function(){
	const vscode = acquireVsCodeApi();
	function selOne(container, btn){ container.querySelectorAll('button').forEach(function(b){ b.classList.remove('sel'); }); btn.classList.add('sel'); }
	const designs = document.getElementById('designs');
	const ratios = document.getElementById('ratios');
	designs.querySelectorAll('button').forEach(function(b){ b.addEventListener('click', function(){ selOne(designs, b); }); });
	ratios.querySelectorAll('button').forEach(function(b){ b.addEventListener('click', function(){ selOne(ratios, b); }); });
	document.getElementById('cancel').addEventListener('click', function(){ vscode.postMessage({ type: 'cancel' }); });
	document.getElementById('create').addEventListener('click', function(){
		const title = document.getElementById('title').value;
		const d = designs.querySelector('.sel'); const r = ratios.querySelector('.sel');
		vscode.postMessage({ type: 'create', title: title, theme: d ? d.dataset.theme : 'plain', aspect: r ? r.dataset.ratio : '16:9' });
	});
	const t = document.getElementById('title'); t.focus(); t.select();
	t.addEventListener('keydown', function(e){ if (e.key === 'Enter') { document.getElementById('create').click(); } });
}());
</script>
</body></html>`;
	}

	dispose(): void {
		NewDeckPanel.current = undefined;
		while (this.disposables.length) { this.disposables.pop()?.dispose(); }
	}
}

function escHtml(s: string): string { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function escAttr(s: string): string { return s.replace(/"/g, '&quot;').replace(/</g, '&lt;'); }
