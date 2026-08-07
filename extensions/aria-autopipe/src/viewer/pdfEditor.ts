/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as path from 'path';

/** Bundled PDF.js (ESM build), shared with the autopipe viewer. */
function pdfjsDir(): string {
	return path.join(__dirname, '..', '..', 'media', 'pdfjs');
}

/**
 * A read-only in-app PDF viewer (pdf.js) registered as the default editor for `.pdf`
 * files. Downloaded paper PDFs (Paper Library) and pipeline result PDFs open inside
 * Qoka as an editor tab instead of an external app. Local files only - rendered via
 * the webview's asWebviewUri, no server round-trip.
 */
export class QokaPdfEditorProvider implements vscode.CustomReadonlyEditorProvider {

	static readonly viewType = 'qoka.pdfViewer';

	openCustomDocument(uri: vscode.Uri): vscode.CustomDocument {
		return { uri, dispose: () => { /* no per-document resources */ } };
	}

	resolveCustomEditor(document: vscode.CustomDocument, panel: vscode.WebviewPanel): void {
		const pdfjs = vscode.Uri.file(pdfjsDir());
		const fileDir = vscode.Uri.file(path.dirname(document.uri.fsPath));
		panel.webview.options = { enableScripts: true, localResourceRoots: [pdfjs, fileDir] };
		panel.webview.html = buildHtml(panel.webview, document.uri);
	}
}

function buildHtml(webview: vscode.Webview, file: vscode.Uri): string {
	const dir = pdfjsDir();
	const libUri = webview.asWebviewUri(vscode.Uri.file(path.join(dir, 'pdf.mjs')));
	const workerUri = webview.asWebviewUri(vscode.Uri.file(path.join(dir, 'pdf.worker.mjs')));
	const docUri = webview.asWebviewUri(file);
	const cspSource = webview.cspSource;
	const csp = [
		`default-src 'none'`,
		`img-src ${cspSource} data: blob:`,
		`style-src ${cspSource} 'unsafe-inline'`,
		`script-src ${cspSource} 'unsafe-inline' 'unsafe-eval'`,
		`worker-src ${cspSource} blob:`,
		`connect-src ${cspSource} data: blob:`,
		`font-src ${cspSource} data:`,
	].join('; ');
	return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<style>
	html,body{margin:0;padding:0;height:100%;background:var(--vscode-editor-background);}
	#toolbar{position:sticky;top:0;display:flex;gap:8px;align-items:center;padding:6px 10px;background:var(--vscode-editorWidget-background);border-bottom:1px solid var(--vscode-widget-border,transparent);font-family:var(--vscode-font-family);font-size:12px;color:var(--vscode-foreground);z-index:1;}
	#toolbar button{cursor:pointer;background:var(--vscode-button-secondaryBackground,rgba(127,127,127,.2));color:var(--vscode-button-secondaryForeground,var(--vscode-foreground));border:none;border-radius:3px;padding:2px 9px;font-size:13px;}
	#pages{padding:12px;display:flex;flex-direction:column;align-items:center;gap:12px;}
	#pages canvas{max-width:100%;box-shadow:0 0 6px rgba(0,0,0,.3);background:#fff;}
	#status{opacity:.7;padding:12px;font-family:var(--vscode-font-family);color:var(--vscode-foreground);}
</style>
</head>
<body>
<div id="toolbar"><button id="zoomout" title="Zoom out">-</button><span id="zoom">130%</span><button id="zoomin" title="Zoom in">+</button></div>
<div id="status">Loading PDF…</div>
<div id="pages"></div>
<script type="module">
	import * as pdfjsLib from '${libUri}';
	pdfjsLib.GlobalWorkerOptions.workerSrc = '${workerUri}';
	const pagesEl = document.getElementById('pages');
	const statusEl = document.getElementById('status');
	const zoomEl = document.getElementById('zoom');
	let scale = 1.3, pdf = null, rendering = false;
	async function renderAll() {
		if (!pdf || rendering) { return; }
		rendering = true;
		pagesEl.innerHTML = '';
		const dpr = window.devicePixelRatio || 1;
		for (let i = 1; i <= pdf.numPages; i++) {
			const page = await pdf.getPage(i);
			const viewport = page.getViewport({ scale: scale * dpr });
			const canvas = document.createElement('canvas');
			canvas.width = viewport.width; canvas.height = viewport.height;
			canvas.style.width = (viewport.width / dpr) + 'px';
			pagesEl.appendChild(canvas);
			await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
		}
		zoomEl.textContent = Math.round(scale * 100) + '%';
		rendering = false;
	}
	document.getElementById('zoomin').onclick = () => { scale = Math.min(3, scale + 0.2); renderAll(); };
	document.getElementById('zoomout').onclick = () => { scale = Math.max(0.4, scale - 0.2); renderAll(); };
	(async () => {
		try {
			pdf = await pdfjsLib.getDocument('${docUri}').promise;
			statusEl.style.display = 'none';
			await renderAll();
		} catch (e) {
			statusEl.textContent = 'Could not render this PDF: ' + (e && e.message ? e.message : e);
		}
	})();
</script>
</body>
</html>`;
}
