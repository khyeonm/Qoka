/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { deletePaper, ensureLibraryFile, listPapers, allTags, updateNote, updateTags } from './library';
import { AriaPaperLibraryMcpServer } from './mcp/server';
import { registerWithClaudeCode } from './registration/claudeCodeMcp';
import { registerWithCodex } from './registration/codexMcp';
import { PaperLibraryState } from './types';

/**
 * Paper Search extension entry. Boots the paper-library MCP server,
 * registers it with Claude Code + Codex, and exposes the commands the
 * Paper Search sidebar view uses to read/write the on-disk library.
 *
 * The MCP exposes only two tools — save_paper, list_saved_papers. All
 * mutating operations on existing library entries (note edit, tag edit,
 * delete) happen here via VS Code commands the sidebar invokes; Claude
 * never gets the chance to silently destroy data.
 */

let mcpServer: AriaPaperLibraryMcpServer | undefined;

export function activate(context: vscode.ExtensionContext): void {
	console.log('[aria-paper-search] activate()');

	ensureLibraryFile();

	mcpServer = new AriaPaperLibraryMcpServer();

	context.subscriptions.push(
		// Sidebar reads — getState shape mirrors the workbench view's
		// expectations, single round-trip per refresh.
		vscode.commands.registerCommand('aria.paperSearch.list', (): PaperLibraryState => ({
			papers: listPapers(),
			tags: allTags(),
		})),

		vscode.commands.registerCommand('aria.paperSearch.delete', async (id: unknown) => {
			if (typeof id !== 'string') {
				return false;
			}
			return deletePaper(id);
		}),

		vscode.commands.registerCommand('aria.paperSearch.updateNote', async (id: unknown, note: unknown) => {
			if (typeof id !== 'string' || typeof note !== 'string') {
				return false;
			}
			return updateNote(id, note);
		}),

		vscode.commands.registerCommand('aria.paperSearch.updateTags', async (id: unknown, tags: unknown) => {
			if (typeof id !== 'string' || !Array.isArray(tags)) {
				return false;
			}
			return updateTags(id, tags.map(t => String(t)));
		}),

		vscode.commands.registerCommand('aria.paperSearch.openUrl', async (url: unknown) => {
			if (typeof url !== 'string' || !url) {
				return;
			}
			try {
				await vscode.env.openExternal(vscode.Uri.parse(url));
			} catch (err) {
				vscode.window.showErrorMessage(`Could not open ${url}: ${(err as Error).message}`);
			}
		}),

		vscode.commands.registerCommand('aria.paperSearch.copyToClipboard', async (text: unknown) => {
			if (typeof text !== 'string') {
				return;
			}
			await vscode.env.clipboard.writeText(text);
			vscode.window.showInformationMessage(`Copied: ${text}`);
		}),

		// Sidebar-driven edit flows. The view fires these because it
		// can't invoke vscode.window directly — workbench-side code
		// only has access to the command bus.
		vscode.commands.registerCommand('aria.paperSearch.promptAndUpdateNote', async (id: unknown) => {
			if (typeof id !== 'string') {
				return;
			}
			const papers = listPapers();
			const paper = papers.find(p => p.id === id);
			if (!paper) {
				return;
			}
			const next = await vscode.window.showInputBox({
				title: `Note for "${truncate(paper.title, 60)}"`,
				prompt: 'Edit your note. Leave blank to clear.',
				value: paper.note,
				ignoreFocusOut: true,
			});
			if (next === undefined) {
				return;
			}
			updateNote(id, next);
		}),

		vscode.commands.registerCommand('aria.paperSearch.promptAndAddTag', async (id: unknown) => {
			if (typeof id !== 'string') {
				return;
			}
			const papers = listPapers();
			const paper = papers.find(p => p.id === id);
			if (!paper) {
				return;
			}
			const added = await vscode.window.showInputBox({
				title: `Add tag to "${truncate(paper.title, 60)}"`,
				prompt: 'Tag name. Multiple tags can be entered separated by commas.',
				placeHolder: 'e.g. CRISPR, must-read',
				ignoreFocusOut: true,
			});
			if (!added) {
				return;
			}
			const incoming = added.split(',').map(s => s.trim()).filter(Boolean);
			const next = [...paper.tags, ...incoming];
			updateTags(id, next);
		}),

		vscode.commands.registerCommand('aria.paperSearch.confirmAndDelete', async (id: unknown) => {
			if (typeof id !== 'string') {
				return;
			}
			const papers = listPapers();
			const paper = papers.find(p => p.id === id);
			if (!paper) {
				return;
			}
			const confirm = await vscode.window.showWarningMessage(
				`Remove "${truncate(paper.title, 80)}" from your library?`,
				{ modal: true },
				'Delete',
			);
			if (confirm !== 'Delete') {
				return;
			}
			deletePaper(id);
		}),
	);

	// Start MCP + register with AI clients in the background. We don't
	// block activate(); the sidebar's library commands work whether or
	// not Claude has discovered the MCP yet.
	void bootMcp();
}

async function bootMcp(): Promise<void> {
	if (!mcpServer) {
		return;
	}
	// Join the workbench startup overlay's tracking. The overlay stays
	// up until every tracked component reports complete, so the user
	// can't poke Claude Code mid-registration.
	await vscode.commands.executeCommand('aria.startup.beginTracking', 'aria-paper-search-mcp');
	let summary = 'Paper Library MCP — already configured';
	let changed = false;
	try {
		const port = await mcpServer.start();
		// Give autopipe (and any other extension that races us to claude
		// CLI) time to finish its own `claude mcp add` before we start
		// ours. The CLI doesn't lock its config file, so concurrent
		// writes can overwrite each other.
		await new Promise(resolve => setTimeout(resolve, 1500));
		console.log(`[aria-paper-search] MCP on ${port}; registering with AI clients`);
		const [claudeResult, codexResult] = await Promise.allSettled([
			registerWithClaudeCode(port),
			registerWithCodex(port),
		]);
		// Surface the actual outcome so silent registration failures
		// (the most common symptom: tools not appearing in Claude) show
		// up in the Developer Tools console with an actionable message.
		if (claudeResult.status === 'fulfilled') {
			const r = claudeResult.value;
			console.log(`[aria-paper-search] Claude Code registration ok=${r.ok} changed=${r.changed}: ${r.message}`);
			if (r.changed) {
				changed = true;
			}
		} else {
			console.error('[aria-paper-search] Claude Code registration threw:', claudeResult.reason);
		}
		if (codexResult.status === 'fulfilled') {
			const r = codexResult.value;
			console.log(`[aria-paper-search] Codex registration ok=${r.ok} changed=${r.changed}: ${r.message}`);
			if (r.changed) {
				changed = true;
			}
		} else {
			console.error('[aria-paper-search] Codex registration threw:', codexResult.reason);
		}
		console.log(`[aria-paper-search] final changed flag = ${changed}`);
		summary = changed
			? 'Paper Library MCP registered'
			: 'Paper Library MCP — already configured';
	} catch (err) {
		console.error('[aria-paper-search] MCP boot failed:', (err as Error).message);
		summary = `Paper Library MCP failed: ${(err as Error).message}`;
		changed = false;
	} finally {
		// Always report — drops us out of the tracking set so the
		// overlay can settle even when registration fails.
		await vscode.commands.executeCommand(
			'aria.startup.markComplete',
			'aria-paper-search-mcp',
			summary,
			changed,
		);
	}
}

function truncate(s: string, max: number): string {
	if (s.length <= max) {
		return s;
	}
	return s.slice(0, max - 1) + '…';
}

export async function deactivate(): Promise<void> {
	console.log('[aria-paper-search] deactivate()');
	// Deliberately DO NOT unregister from Claude / Codex on shutdown.
	// Removing the entry from ~/.claude.json on every Aria close means
	// the next launch always has to re-add — Aria UI then shows
	// "Paper Library MCP registered" every time even though the
	// effective state is unchanged. autopipe follows the same pattern:
	// the registration persists across runs so the optimization can
	// actually fire.
	if (mcpServer) {
		await mcpServer.stop();
		mcpServer = undefined;
	}
}
