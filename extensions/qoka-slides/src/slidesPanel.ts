/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The Slides tab: a single editor-area webview panel that hosts the whole app -
// a deck list on the left, the live-rendered deck in the centre, a toolbar on
// top. The deck's text.xml is the source of truth; a file watcher pushes fresh
// markup so an MCP edit (or a hand edit) re-renders in place. Manual drag
// editing + export land in a later phase; this phase is the live viewer.

import * as vscode from 'vscode';
import * as crypto from 'crypto';
import {
	listDecks, readMeta, readText, readFigures, deckDir, figuresDir, slidesRoot,
	newSlug, createDeck, deleteDeck, canvasFor, Aspect, DeckMeta,
} from './storage';
import { loadTheme, listThemes, themeVars } from './themes';
import { seedDeckXml } from './templates';

export class SlidesPanel {
	private static current: SlidesPanel | undefined;
	private readonly panel: vscode.WebviewPanel;
	private readonly disposables: vscode.Disposable[] = [];
	private watcher: vscode.FileSystemWatcher | undefined;
	private currentSlug: string | undefined;

	static open(extensionUri: vscode.Uri): void {
		if (SlidesPanel.current) {
			SlidesPanel.current.panel.reveal(vscode.ViewColumn.Active);
			return;
		}
		const localRoots: vscode.Uri[] = [vscode.Uri.joinPath(extensionUri, 'media'), vscode.Uri.joinPath(extensionUri, 'themes')];
		try { localRoots.push(vscode.Uri.file(slidesRoot())); } catch { /* no workspace yet */ }
		const panel = vscode.window.createWebviewPanel('qoka.slides', 'Slides', vscode.ViewColumn.Active, {
			enableScripts: true,
			retainContextWhenHidden: true,
			localResourceRoots: localRoots,
		});
		SlidesPanel.current = new SlidesPanel(panel, extensionUri);
	}

	private get themesRoot(): string { return vscode.Uri.joinPath(this.extensionUri, 'themes').fsPath; }

	private constructor(panel: vscode.WebviewPanel, private readonly extensionUri: vscode.Uri) {
		this.panel = panel;
		this.panel.webview.html = this.html();
		this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
		this.panel.webview.onDidReceiveMessage((m) => this.onMessage(m), null, this.disposables);
		void this.sendDeckList();
	}

	private async onMessage(m: { type?: string;[k: string]: unknown }): Promise<void> {
		try {
			switch (m.type) {
				case 'ready': await this.sendDeckList(); break;
				case 'selectDeck': await this.selectDeck(String(m.slug)); break;
				case 'newDeck': await this.newDeck(String(m.title || 'Untitled'), String(m.theme || 'plain'), (m.aspect === '4:3' ? '4:3' : '16:9')); break;
				case 'deleteDeck': {
					const slug = String(m.slug);
					const meta = await readMeta(slug);
					const pick = await vscode.window.showWarningMessage(`Delete deck "${meta.title ?? slug}"? This cannot be undone.`, { modal: true }, 'Delete');
					if (pick === 'Delete') {
						await deleteDeck(slug);
						if (this.currentSlug === slug) { this.currentSlug = undefined; }
						await this.sendDeckList();
					}
					break;
				}
				case 'listThemes': this.post({ type: 'themes', themes: listThemes(this.themesRoot) }); break;
			}
		} catch (e) {
			this.post({ type: 'error', message: (e as Error).message });
		}
	}

	private post(msg: unknown): void { void this.panel.webview.postMessage(msg); }

	private async sendDeckList(): Promise<void> {
		let decks: { slug: string; title: string }[] = [];
		try {
			decks = (await listDecks()).map(d => ({ slug: d.slug, title: d.meta.title ?? d.slug }));
		} catch { /* no workspace / no decks */ }
		this.post({ type: 'decks', decks, themes: listThemes(this.themesRoot), selected: this.currentSlug });
	}

	private async selectDeck(slug: string): Promise<void> {
		this.currentSlug = slug;
		this.watch(slug);
		await this.sendDeck(slug);
	}

	private async newDeck(title: string, themeId: string, aspect: Aspect): Promise<void> {
		const theme = loadTheme(this.themesRoot, themeId, aspect);
		const meta: DeckMeta = { title, theme: themeId, aspect };
		const seed = theme ? seedDeckXml(theme) : '<section class="slide"><div class="slide-inner"></div></section>';
		const slug = await newSlug(title);
		await createDeck(slug, meta, seed);
		await this.sendDeckList();
		await this.selectDeck(slug);
	}

	/** Re-render the deck whenever any file in its directory changes on disk. */
	private watch(slug: string): void {
		this.watcher?.dispose();
		let pattern: vscode.RelativePattern;
		try { pattern = new vscode.RelativePattern(vscode.Uri.file(deckDir(slug)), '**/*'); } catch { return; }
		const w = vscode.workspace.createFileSystemWatcher(pattern);
		const refresh = () => { if (this.currentSlug === slug) { void this.sendDeck(slug); } };
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
			const figs = await readFigures(slug);
			for (const [key, file] of Object.entries(figs)) {
				figMap[key] = this.panel.webview.asWebviewUri(vscode.Uri.joinPath(vscode.Uri.file(figuresDir(slug)), file)).toString();
			}
		} catch { /* no images */ }

		this.post({
			type: 'deck',
			slug,
			title: meta.title ?? slug,
			html,
			figures: figMap,
			themeVars: theme ? themeVars(theme) : themeVars(loadTheme(this.themesRoot, 'plain', aspect) ?? blankTheme(aspect)),
			themeCss: theme?.css ?? '',
			canvas: canvasFor(aspect),
		});
	}

	private html(): string {
		const webview = this.panel.webview;
		const nonce = crypto.randomBytes(16).toString('hex');
		const media = (f: string) => webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', f)).toString();
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
<meta name="viewport" content="width=device-width, initial-scale=1" />
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin="anonymous" />
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;700&family=Lora:wght@400;500;600;700&family=Merriweather:wght@400;700&family=Montserrat:wght@400;500;600;700&family=Noto+Sans+KR:wght@400;500;700&family=Noto+Serif+KR:wght@400;500;600;700&family=Open+Sans:wght@400;500;700&family=Playfair+Display:wght@400;600;700&family=Roboto:wght@400;500;700&family=Source+Serif+4:wght@400;600;700&display=swap" />
<link rel="stylesheet" href="${media('app.css')}" />
<link rel="stylesheet" href="${media('slide.css')}" />
</head>
<body>
<div id="app">
	<aside id="sidebar">
		<div id="sidebar-head">
			<span>Decks</span>
			<button id="new-btn" type="button">+ New</button>
		</div>
		<ul id="deck-list"></ul>
	</aside>
	<main id="stage">
		<div id="toolbar">
			<span id="deck-title"></span>
			<span id="spacer"></span>
			<button id="prev" type="button" title="Previous slide">&#8249;</button>
			<span id="counter"></span>
			<button id="next" type="button" title="Next slide">&#8250;</button>
			<button id="present" type="button">Slideshow</button>
		</div>
		<div id="frame"><div class="deck" id="deck"></div></div>
		<div id="empty">No deck selected. Pick one on the left, or ask the AI to create slides.</div>
	</main>
</div>
<div id="newdlg" hidden>
	<div class="dlg">
		<h3>New deck</h3>
		<label>Title <input id="nd-title" type="text" placeholder="My deck" /></label>
		<div class="field"><span>Design</span><div id="nd-themes"></div></div>
		<div class="field"><span>Ratio</span>
			<div id="nd-ratio">
				<button data-ratio="16:9" class="sel" type="button">16:9</button>
				<button data-ratio="4:3" type="button">4:3</button>
			</div>
		</div>
		<div class="dlg-actions"><button id="nd-cancel" type="button">Cancel</button><button id="nd-create" type="button">Create</button></div>
	</div>
</div>
<script nonce="${nonce}" src="${media('slides.js')}"></script>
</body>
</html>`;
	}

	dispose(): void {
		SlidesPanel.current = undefined;
		this.watcher?.dispose();
		while (this.disposables.length) { this.disposables.pop()?.dispose(); }
	}
}

/** Fallback theme (used only to supply canvas vars when a deck has no theme). */
function blankTheme(aspect: Aspect) {
	return {
		id: 'plain', name: 'Basic', description: '', aspect, accent: '#334155', accentSoft: '#e2e8f0',
		foot: '', pageNumber: '', logo: false, logoUrl: null, logoSize: '45px', chromeLogo: false,
		fonts: { head: '"Source Serif 4", serif', body: '"Source Serif 4", serif', ui: '"Open Sans", sans-serif', mono: '"JetBrains Mono", monospace' },
		strip: false, headSize: '44.5741px', titleSize: '64.8px', templates: [], css: '',
	};
}
