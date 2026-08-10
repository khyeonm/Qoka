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
 * A read-only in-app PDF viewer (pdf.js). Registered as the DEFAULT editor for
 * `.pdf`, except downloaded paper PDFs under `.qoka/references/pdfs/`, which a
 * configurationDefault association routes to VS Code's built-in editor so a
 * plain Explorer click opens them like any other file. The Paper Library opens
 * its PDFs with THIS viewer explicitly (vscode.openWith), so that path is
 * unaffected. Local files only - rendered via the webview's asWebviewUri.
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
	/* width:fit-content + min-width:100% lets the page column grow WIDER than the
	   viewport when zoomed (so zoom actually enlarges the page and you pan to it),
	   while still filling and centering when the page is narrower than the viewer.
	   A max-width:100% on the canvas would clamp the displayed width and make zoom
	   look like it does nothing. */
	#pages{padding:12px;box-sizing:border-box;display:flex;flex-direction:column;align-items:center;gap:12px;width:fit-content;min-width:100%;cursor:grab;}
	#pages.grabbing{cursor:grabbing;}
	#pages canvas{box-shadow:0 0 6px rgba(0,0,0,.3);background:#fff;}
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
	let pdf = null, zoom = 1.3;
	// Natural (scale-1) CSS size of each page, in page order. The display size at
	// the current zoom is natural * zoom.
	const naturals = [];

	// Rasterize EVERY page ONCE at a fixed resolution, then let zoom resize the
	// already-rendered canvases purely via CSS. The old code re-rasterized (clear +
	// rebuild) on every zoom step, which flickered and - when a re-render didn't
	// land - left the page the same size or blank. Rendering once and CSS-scaling
	// is flicker-free and the page reliably grows. RENDER=2 keeps it crisp up to
	// ~2x zoom (slightly soft beyond, which is fine for reading).
	async function renderAll() {
		if (!pdf) { return; }
		const dpr = window.devicePixelRatio || 1;
		const RENDER = 2;
		pagesEl.innerHTML = '';
		naturals.length = 0;
		for (let i = 1; i <= pdf.numPages; i++) {
			const page = await pdf.getPage(i);
			const natural = page.getViewport({ scale: 1 });
			naturals.push({ w: natural.width, h: natural.height });
			const viewport = page.getViewport({ scale: RENDER * dpr });
			const canvas = document.createElement('canvas');
			canvas.width = viewport.width; canvas.height = viewport.height;
			sizeCanvas(canvas, i - 1);
			pagesEl.appendChild(canvas);
			await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
		}
		applyZoom();
	}
	// Set BOTH display dimensions explicitly so the layout always reflects the
	// zoom (leaving height:auto let some HiDPI setups ignore the width change).
	function sizeCanvas(canvas, idx) {
		const n = naturals[idx];
		if (!n) { return; }
		canvas.style.width = (n.w * zoom) + 'px';
		canvas.style.height = (n.h * zoom) + 'px';
	}
	function applyZoom() {
		const list = pagesEl.querySelectorAll('canvas');
		for (let i = 0; i < list.length; i++) { sizeCanvas(list[i], i); }
		zoomEl.textContent = Math.round(zoom * 100) + '%';
	}
	function setZoom(next) {
		zoom = Math.min(3, Math.max(0.4, Math.round(next * 100) / 100));
		applyZoom(); // instant - just resizes the existing canvases, no re-render
	}
	document.getElementById('zoomin').onclick = () => setZoom(zoom + 0.2);
	document.getElementById('zoomout').onclick = () => setZoom(zoom - 0.2);
	// Ctrl + mouse wheel to zoom. (Ctrl +/- is intentionally NOT handled here -
	// that keybinding zooms the whole Qoka window and a webview cannot suppress it.)
	window.addEventListener('wheel', (e) => {
		if (!(e.ctrlKey || e.metaKey)) { return; }
		e.preventDefault();
		setZoom(zoom + (e.deltaY < 0 ? 0.12 : -0.12));
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
