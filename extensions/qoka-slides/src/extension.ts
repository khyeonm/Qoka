/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as path from 'path';
import { buildTools } from './mcp/tools';
import { QokaSlidesMcpServer } from './mcp/server';
import { DeckEditorPanel } from './deckEditorPanel';
import { NewDeckPanel } from './newDeckPanel';
import { newSlug, createDeck, deleteDeck, readMeta, writeMeta, DeckMeta } from './storage';
import { listThemes, loadTheme } from './themes';
import { seedDeckXml } from './templates';
import { registerWithClaudeCode } from './registration/claudeCodeMcp';
import { registerWithCodex } from './registration/codexMcp';

let mcpServer: QokaSlidesMcpServer | undefined;

async function registerAllProviders(port: number): Promise<{ changed: boolean; registered: boolean }> {
	const results = await Promise.allSettled([registerWithClaudeCode(port), registerWithCodex(port)]);
	const labels = ['Claude Code', 'Codex'];
	let registered = false;
	let changed = false;
	results.forEach((r, i) => {
		if (r.status === 'fulfilled') {
			console.log(`[qoka-slides] ${labels[i]}: ${r.value.message}`);
			if (r.value.ok) { registered = true; if (r.value.changed) { changed = true; } }
		} else {
			console.warn(`[qoka-slides] ${labels[i]} registration threw:`, r.reason);
		}
	});
	return { changed, registered };
}

export function activate(context: vscode.ExtensionContext): void {
	console.log('[qoka-slides] activate()');
	const extUri = context.extensionUri;
	const themesRoot = path.join(extUri.fsPath, 'themes');

	// --- Slides commands (the deck list is a core sidebar view that calls these) --
	context.subscriptions.push(vscode.commands.registerCommand('qoka.slides.open', async () => {
		try { await vscode.commands.executeCommand('workbench.view.qokaSlides'); } catch { /* container not ready */ }
	}));
	context.subscriptions.push(vscode.commands.registerCommand('qoka.slides.openDeck', (slug: string) => {
		if (slug) { DeckEditorPanel.open(extUri, slug); }
	}));

	context.subscriptions.push(vscode.commands.registerCommand('qoka.slides.new', () => {
		const designs = listThemes(themesRoot).map(t => ({ id: t.id, name: t.name }));
		NewDeckPanel.open(designs, async (choice) => {
			try {
				const theme = loadTheme(themesRoot, choice.theme, choice.aspect);
				const seed = theme ? seedDeckXml(theme) : '<section class="slide"><div class="slide-inner"></div></section>';
				const meta: DeckMeta = { title: choice.title, theme: choice.theme, aspect: choice.aspect };
				const slug = await newSlug(choice.title);
				await createDeck(slug, meta, seed);
				DeckEditorPanel.open(extUri, slug);
			} catch (e) {
				void vscode.window.showErrorMessage(`Could not create the slide deck: ${(e as Error).message}`);
			}
		});
	}));

	context.subscriptions.push(vscode.commands.registerCommand('qoka.slides.rename', async (slug: string) => {
		if (!slug) { return; }
		const meta = await readMeta(slug);
		const title = (await vscode.window.showInputBox({ prompt: 'Slides title', value: meta.title ?? slug, ignoreFocusOut: true }))?.trim();
		if (!title) { return; }
		meta.title = title;
		await writeMeta(slug, meta);
	}));

	context.subscriptions.push(vscode.commands.registerCommand('qoka.slides.delete', async (slug: string) => {
		if (!slug) { return; }
		const meta = await readMeta(slug);
		const pick = await vscode.window.showWarningMessage(`Delete "${meta.title ?? slug}"? This cannot be undone.`, { modal: true }, 'Delete');
		if (pick === 'Delete') { await deleteDeck(slug); }
	}));

	// --- MCP server ----------------------------------------------------------
	mcpServer = new QokaSlidesMcpServer(buildTools(extUri.fsPath));
	const startPromise = mcpServer.start();
	startPromise.catch(() => { /* handled below */ });

	void (async () => {
		await vscode.commands.executeCommand('aria.startup.beginTracking', 'qoka-slides-mcp');
		let summary = 'Slides MCP - already configured';
		try {
			const port = await startPromise;
			summary = `Slides MCP up on ${port}`;
		} catch (e) {
			summary = `Slides MCP startup failed: ${(e as Error).message}`;
		} finally {
			await vscode.commands.executeCommand('aria.startup.markComplete', 'qoka-slides-mcp', summary, false);
		}
	})();

	context.subscriptions.push(vscode.commands.registerCommand('aria.slides.mcpInfo', async () => {
		const port = await startPromise.catch(() => undefined);
		return port === undefined ? null : { name: 'qoka-slides', port };
	}));

	context.subscriptions.push(vscode.commands.registerCommand('aria.slides.reregisterMcp', async () => {
		const port = await startPromise.catch(() => undefined);
		if (port === undefined) { return { changed: false, registered: false }; }
		return registerAllProviders(port);
	}));
}

export async function deactivate(): Promise<void> {
	console.log('[qoka-slides] deactivate()');
	if (mcpServer) {
		await mcpServer.stop();
		mcpServer = undefined;
	}
}
