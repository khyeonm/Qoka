/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The Slides editor: an editor-area webview that renders ONE deck (its sections
// scaled to fit, navigable, with a slideshow mode). The deck list lives in the
// sidebar tree; picking a deck opens/loads it here. A file watcher pushes fresh
// markup so an MCP or hand edit re-renders in place. Render-only for now; manual
// drag editing + export land in a later phase.

import * as vscode from 'vscode';
import * as crypto from 'crypto';
import { readMeta, readText, writeText, readFigures, deckDir, figuresDir, slidesRoot, canvasFor, Aspect } from './storage';
import { loadTheme, themeVars, Theme } from './themes';
import { exportDeckToPptx, ExportModel } from './pptxExport';

export class DeckEditorPanel {
	private static current: DeckEditorPanel | undefined;
	private readonly panel: vscode.WebviewPanel;
	private readonly disposables: vscode.Disposable[] = [];
	private watcher: vscode.FileSystemWatcher | undefined;
	private slug: string | undefined;
	/** Set while WE write text.xml (from a webview edit) so the file watcher does
	 *  not re-render and clobber the user's in-progress edit. */
	private suppressWatch = false;

	static open(extensionUri: vscode.Uri, slug: string): void {
		if (DeckEditorPanel.current) {
			DeckEditorPanel.current.panel.reveal(vscode.ViewColumn.Active);
			void DeckEditorPanel.current.load(slug);
			return;
		}
		const roots: vscode.Uri[] = [vscode.Uri.joinPath(extensionUri, 'media'), vscode.Uri.joinPath(extensionUri, 'themes')];
		try { roots.push(vscode.Uri.file(slidesRoot())); } catch { /* no workspace */ }
		const panel = vscode.window.createWebviewPanel('qoka.slides.editor', 'Slides', vscode.ViewColumn.Active, {
			enableScripts: true,
			retainContextWhenHidden: true,
			localResourceRoots: roots,
		});
		DeckEditorPanel.current = new DeckEditorPanel(panel, extensionUri);
		void DeckEditorPanel.current.load(slug);
	}

	private get themesRoot(): string { return vscode.Uri.joinPath(this.extensionUri, 'themes').fsPath; }

	private constructor(panel: vscode.WebviewPanel, private readonly extensionUri: vscode.Uri) {
		this.panel = panel;
		this.panel.webview.html = this.html();
		this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
		this.panel.webview.onDidReceiveMessage((m) => {
			if (!m) { return; }
			if (m.type === 'ready' && this.slug) { void this.sendDeck(this.slug); }
			else if (m.type === 'save' && this.slug && typeof m.html === 'string') { void this.save(this.slug, m.html); }
			else if (m.type === 'export') { void this.chooseExport(); }
			else if (m.type === 'geometry' && this.slug && m.model) { void this.exportPptx(this.slug, m.model as ExportModel); }
		}, null, this.disposables);
	}

	private async load(slug: string): Promise<void> {
		this.slug = slug;
		const meta = await readMeta(slug);
		this.panel.title = meta.title ?? slug;
		this.watch(slug);
		await this.sendDeck(slug);
	}

	private watch(slug: string): void {
		this.watcher?.dispose();
		let pattern: vscode.RelativePattern;
		try { pattern = new vscode.RelativePattern(vscode.Uri.file(deckDir(slug)), '**/*'); } catch { return; }
		const w = vscode.workspace.createFileSystemWatcher(pattern);
		const refresh = () => { if (this.slug === slug && !this.suppressWatch) { void this.sendDeck(slug); } };
		w.onDidChange(refresh); w.onDidCreate(refresh); w.onDidDelete(refresh);
		this.watcher = w;
		this.disposables.push(w);
	}

	private async sendDeck(slug: string): Promise<void> {
		const meta = await readMeta(slug);
		const xml = (await readText(slug)) ?? '';
		const aspect = meta.aspect ?? '16:9';
		const theme = meta.theme ? loadTheme(this.themesRoot, meta.theme, aspect) : undefined;

		// Rewrite theme background refs (`/themes/<id>/<file>`) to webview URIs.
		let html = xml;
		if (meta.theme) {
			const base = this.panel.webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'themes', meta.theme)).toString();
			html = html.split(`/themes/${meta.theme}/`).join(base + '/');
		}

		// Figure key -> webview URI (the deck's images/ dir).
		const figMap: Record<string, string> = {};
		try {
			for (const [key, file] of Object.entries(await readFigures(slug))) {
				figMap[key] = this.panel.webview.asWebviewUri(vscode.Uri.joinPath(vscode.Uri.file(figuresDir(slug)), file)).toString();
			}
		} catch { /* no images */ }

		const vars = theme ? themeVars(theme) : themeVars(fallbackTheme(aspect));
		this.panel.webview.postMessage({ type: 'deck', title: meta.title ?? slug, html, figures: figMap, themeVars: vars, themeCss: theme?.css ?? '', canvas: canvasFor(aspect) });
	}

	/** Persist an edit from the webview. Reverses the render-time rewrites (theme
	 *  asset webview URIs -> `/themes/<id>/...`) so text.xml keeps portable refs,
	 *  and suppresses the file watcher so our own write does not bounce back. */
	private async save(slug: string, html: string): Promise<void> {
		const meta = await readMeta(slug);
		let out = html;
		if (meta.theme) {
			const base = this.panel.webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'themes', meta.theme)).toString();
			out = out.split(base + '/').join(`/themes/${meta.theme}/`);
		}
		this.suppressWatch = true;
		try {
			await writeText(slug, out);
		} catch (e) {
			void vscode.window.showErrorMessage(`Could not save slides: ${(e as Error).message}`);
		} finally {
			setTimeout(() => { this.suppressWatch = false; }, 400);
		}
	}

	/** Export flow: ask the user for a format. PDF prints the rendered slides (high
	 *  fidelity, via the webview); PPTX asks the webview for element geometry and
	 *  builds an editable deck (after warning about the CSS-only styling that is lost). */
	private async chooseExport(): Promise<void> {
		if (!this.slug) { return; }
		const pick = await vscode.window.showQuickPick(
			[
				{ label: 'PDF', detail: 'High-fidelity print of the slides exactly as rendered (save as PDF in the print dialog).' },
				{ label: 'PowerPoint (.pptx)', detail: 'Editable slides you can rearrange in PowerPoint. Theme backgrounds, gradients and web fonts may be lost.' },
			],
			{ placeHolder: 'Export slides as', ignoreFocusOut: true },
		);
		if (!pick) { return; }
		if (pick.label === 'PDF') {
			this.panel.webview.postMessage({ type: 'print' });
			return;
		}
		const proceed = await vscode.window.showWarningMessage(
			'Export to editable PowerPoint. Text and images become native, editable shapes, but theme backgrounds, gradient fills and custom web fonts may not carry over exactly.',
			{ modal: true },
			'Export',
		);
		if (proceed === 'Export') { this.panel.webview.postMessage({ type: 'extract' }); }
	}

	private async exportPptx(slug: string, model: ExportModel): Promise<void> {
		try {
			const saved = await exportDeckToPptx(slug, model);
			if (saved) { void vscode.window.showInformationMessage(`Slides exported to ${saved}`); }
		} catch (e) {
			void vscode.window.showErrorMessage(`Could not export PowerPoint: ${(e as Error).message}`);
		}
	}

	private html(): string {
		const webview = this.panel.webview;
		const nonce = crypto.randomBytes(16).toString('hex');
		const media = (f: string) => webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', f)).toString();
		const advanced = vscode.workspace.getConfiguration().get<string>('aria.mode') === 'advanced';
		const accent = advanced ? '' : ':root{--vscode-button-background:#2ba7c9!important;--vscode-button-hoverBackground:#2496b6!important;}';
		const csp = [
			`default-src 'none'`,
			`style-src ${webview.cspSource} https://fonts.googleapis.com 'unsafe-inline'`,
			`font-src https://fonts.gstatic.com`,
			`img-src ${webview.cspSource} https: data:`,
			`script-src 'nonce-${nonce}'`,
		].join('; ');
		return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin="anonymous" />
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;700&family=Lora:wght@400;500;600;700&family=Merriweather:wght@400;700&family=Montserrat:wght@400;500;600;700&family=Noto+Sans+KR:wght@400;500;700&family=Noto+Serif+KR:wght@400;500;600;700&family=Open+Sans:wght@400;500;700&family=Playfair+Display:wght@400;600;700&family=Roboto:wght@400;500;700&family=Source+Serif+4:wght@400;600;700&display=swap" />
<link rel="stylesheet" href="${media('slide.css')}" />
<style>
	${accent}
	html, body { height: 100%; margin: 0; }
	body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); overflow: hidden; }
	button { font-family: inherit; color: var(--vscode-button-secondaryForeground, var(--vscode-foreground)); background: var(--vscode-button-secondaryBackground, transparent); border: 1px solid var(--vscode-contrastBorder, transparent); border-radius: 4px; padding: 3px 10px; cursor: pointer; }
	button:hover { background: var(--vscode-button-secondaryHoverBackground, var(--vscode-toolbar-hoverBackground)); }
	#stage { display: flex; flex-direction: column; height: 100vh; }
	#toolbar { display: flex; align-items: center; gap: 8px; padding: 6px 12px; border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,.2)); }
	#deck-title { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 45%; }
	#spacer { flex: 1; }
	#counter { font-variant-numeric: tabular-nums; opacity: .8; min-width: 56px; text-align: center; }
	#present { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border-color: transparent; }
	#frame { flex: 1; position: relative; display: flex; align-items: center; justify-content: center; overflow: hidden; background: var(--vscode-editorWidget-background, #2a2a2a); padding: 12px; }
	.deck { display: flex; align-items: center; justify-content: center; }
	#frame .deck .slide { position: relative; overflow: hidden; margin: auto; background: #fff; box-shadow: 0 4px 24px rgba(0,0,0,.35); }
	#frame .deck .slide .slide-inner { position: absolute; top: 0; left: 0; transform-origin: top left; transform: scale(var(--scale, 1)); }
	#empty { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; color: var(--vscode-descriptionForeground); padding: 24px; text-align: center; }
	[hidden] { display: none !important; }
	body.present #toolbar { display: none; }
	body.present #frame { background: #000; padding: 0; }
	#editBtn { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border-color: transparent; }
	body.editing #frame .deck .slide .slide-inner > * { outline: 1px dashed transparent; }
	body.editing #frame .deck .slide .slide-inner > *:hover { outline-color: rgba(43,167,201,.55); cursor: move; }
	#overlay { position: absolute; pointer-events: none; border: 1.5px solid #2ba7c9; box-sizing: border-box; z-index: 5; }
	#handle { position: absolute; right: -5px; bottom: -5px; width: 11px; height: 11px; background: #2ba7c9; border: 1px solid #fff; border-radius: 2px; pointer-events: auto; cursor: nwse-resize; }
	#filmstrip { flex: none; display: flex; gap: 8px; padding: 8px 12px; overflow-x: auto; border-top: 1px solid var(--vscode-panel-border, rgba(128,128,128,.2)); background: var(--vscode-sideBar-background, var(--vscode-editor-background)); }
	.thumb { position: relative; flex: none; overflow: hidden; background: #fff; border: 1px solid var(--vscode-panel-border, rgba(128,128,128,.3)); border-radius: 3px; cursor: pointer; }
	.thumb.active { outline: 2px solid #2ba7c9; outline-offset: -1px; }
	.thumb .slide-inner { position: absolute; top: 0; left: 0; transform-origin: top left; transform: scale(var(--scale, 1)); pointer-events: none; }
	.thumb-n { position: absolute; left: 2px; bottom: 1px; font-size: 9px; padding: 0 3px; border-radius: 3px; background: rgba(0,0,0,.55); color: #fff; }
	body.present #filmstrip { display: none; }
</style>
</head>
<body>
<div id="stage">
	<div id="toolbar">
		<span id="deck-title"></span>
		<span id="spacer"></span>
		<button id="exportBtn" type="button" title="Export to PDF or PowerPoint">Export</button>
		<button id="editBtn" type="button">Edit</button>
		<button id="prev" type="button" title="Previous slide">&#8249;</button>
		<span id="counter"></span>
		<button id="next" type="button" title="Next slide">&#8250;</button>
		<button id="present" type="button">Slideshow</button>
	</div>
	<div id="frame"><div class="deck" id="deck"></div><div id="overlay" hidden><div id="handle"></div></div><div id="empty">Loading...</div></div>
	<div id="filmstrip"></div>
</div>
<script nonce="${nonce}" src="${media('editor.js')}"></script>
</body>
</html>`;
	}

	dispose(): void {
		DeckEditorPanel.current = undefined;
		this.watcher?.dispose();
		while (this.disposables.length) { this.disposables.pop()?.dispose(); }
	}
}

/** Minimal theme supplying only canvas vars when a deck has no theme. */
function fallbackTheme(aspect: Aspect): Theme {
	return {
		id: 'plain', name: 'Basic', description: '', aspect, accent: '#334155', accentSoft: '#e2e8f0',
		foot: '', pageNumber: '', logo: false, logoUrl: null, logoSize: '45px', chromeLogo: false,
		fonts: { head: '"Source Serif 4", serif', body: '"Source Serif 4", serif', ui: '"Open Sans", sans-serif', mono: '"JetBrains Mono", monospace' },
		strip: false, headSize: '44.5741px', titleSize: '64.8px', templates: [], css: '',
	};
}
