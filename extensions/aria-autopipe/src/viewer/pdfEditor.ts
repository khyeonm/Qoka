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
	#toolbar .hint{opacity:.55;font-size:11px;margin-left:6px;}
	#pages{padding:12px;display:flex;flex-direction:column;align-items:center;gap:12px;cursor:grab;}
	#pages.grabbing{cursor:grabbing;}
	#pages canvas{max-width:100%;box-shadow:0 0 6px rgba(0,0,0,.3);background:#fff;}
	#status{opacity:.7;padding:12px;font-family:var(--vscode-font-family);color:var(--vscode-foreground);}
</style>
</head>
<body>
<div id="toolbar"><button id="zoomout" title="Zoom out">-</button><span id="zoom">130%</span><button id="zoomin" title="Zoom in">+</button><span class="hint">Ctrl + scroll to zoom, drag to move</span></div>
<div id="status">Loading PDF…</div>
<div id="pages"></div>
<script type="module">
	import * as pdfjsLib from '${libUri}';
	pdfjsLib.GlobalWorkerOptions.workerSrc = '${workerUri}';
	const pagesEl = document.getElementById('pages');
	const statusEl = document.getElementById('status');
	const zoomEl = document.getElementById('zoom');
	let scale = 1.3, pdf = null, rendering = false, wantRender = false;
	async function renderAll() {
		if (!pdf) { return; }
		// If a render is already running, just flag that another pass is needed;
		// the running loop picks up the latest scale when it finishes. Without
		// this, a zoom that arrives mid-render was silently dropped (the % changed
		// but the pages never re-rasterized).
		if (rendering) { wantRender = true; return; }
		rendering = true;
		try {
			do {
				wantRender = false;
				const s = scale;
				const dpr = window.devicePixelRatio || 1;
				pagesEl.innerHTML = '';
				for (let i = 1; i <= pdf.numPages; i++) {
					const page = await pdf.getPage(i);
					const viewport = page.getViewport({ scale: s * dpr });
					const canvas = document.createElement('canvas');
					canvas.width = viewport.width; canvas.height = viewport.height;
					canvas.style.width = (viewport.width / dpr) + 'px';
					pagesEl.appendChild(canvas);
					await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
				}
				zoomEl.textContent = Math.round(s * 100) + '%';
			} while (wantRender);
		} finally {
			rendering = false;
		}
	}
	let renderTimer = null;
	function setZoom(next) {
		scale = Math.min(3, Math.max(0.4, Math.round(next * 100) / 100));
		zoomEl.textContent = Math.round(scale * 100) + '%';
		// Debounce re-render so a fast wheel burst rasterizes once.
		if (renderTimer) { clearTimeout(renderTimer); }
		renderTimer = setTimeout(() => { renderTimer = null; renderAll(); }, 60);
	}
	document.getElementById('zoomin').onclick = () => setZoom(scale + 0.2);
	document.getElementById('zoomout').onclick = () => setZoom(scale - 0.2);
	// Ctrl + mouse wheel to zoom. (Ctrl +/- is intentionally NOT handled here -
	// that keybinding zooms the whole Qoka window and a webview cannot suppress it.)
	window.addEventListener('wheel', (e) => {
		if (!(e.ctrlKey || e.metaKey)) { return; }
		e.preventDefault();
		setZoom(scale + (e.deltaY < 0 ? 0.12 : -0.12));
	}, { passive: false });
	// Drag anywhere (except the toolbar) to pan the pages.
	(function () {
		const sc = document.scrollingElement || document.documentElement;
		let dragging = false, sx = 0, sy = 0, sl = 0, st = 0;
		document.addEventListener('mousedown', (e) => {
			if (e.target && e.target.closest && e.target.closest('#toolbar')) { return; }
			dragging = true; sx = e.clientX; sy = e.clientY; sl = sc.scrollLeft; st = sc.scrollTop;
			pagesEl.classList.add('grabbing');
			e.preventDefault();
		});
		window.addEventListener('mousemove', (e) => {
			if (!dragging) { return; }
			sc.scrollLeft = sl - (e.clientX - sx);
			sc.scrollTop = st - (e.clientY - sy);
		});
		window.addEventListener('mouseup', () => {
			if (!dragging) { return; }
			dragging = false;
			pagesEl.classList.remove('grabbing');
		});
	})();
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
