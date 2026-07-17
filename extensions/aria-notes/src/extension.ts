/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { buildTools } from './mcp/tools';
import { AriaNotesMcpServer } from './mcp/server';
import { registerWithClaudeCode } from './registration/claudeCodeMcp';
import { registerWithCodex } from './registration/codexMcp';

let mcpServer: AriaNotesMcpServer | undefined;

/**
 * Register the notes MCP with every AI provider whose CLI is available
 * (Claude Code, Codex). The server serves both /sse (Claude) and
 * /mcp (Codex) on the same port, so each provider is pointed at
 * the endpoint it understands. Each call tolerates a missing CLI, so
 * providers the user hasn't installed are silently skipped.
 */
async function registerAllProviders(port: number): Promise<{ changed: boolean; summary: string }> {
	const results = await Promise.allSettled([
		registerWithClaudeCode(port),
		registerWithCodex(port),
	]);
	const labels = ['Claude Code', 'Codex'];
	const registered: string[] = [];
	let changed = false;
	results.forEach((r, i) => {
		if (r.status === 'fulfilled') {
			console.log(`[aria-notes] ${labels[i]}: ${r.value.message}`);
			if (r.value.ok) {
				registered.push(labels[i]);
				if (r.value.changed) { changed = true; }
			}
		} else {
			console.warn(`[aria-notes] ${labels[i]} registration threw:`, r.reason);
		}
	});
	const summary = registered.length
		? `Notes MCP registered with ${registered.join(', ')}`
		: 'Notes MCP - no AI provider CLI found yet';
	return { changed, summary };
}

/**
 * Aria Notes - boots a local MCP server so an AI assistant can read notes
 * (as Markdown) and propose edits. Edits are not written directly: the server
 * fires `aria.notes.workbench.onProposal`, and the workbench note editor shows
 * the change for the user to Accept/Reject.
 */
export function activate(context: vscode.ExtensionContext): void {
	console.log('[aria-notes] activate()');

	const propose = (
		filePath: string,
		title: string,
		blocks: unknown[],
		currentMarkdown: string,
		proposedMarkdown: string,
	) => {
		void vscode.commands.executeCommand('aria.notes.workbench.onProposal', {
			filePath, title, blocks, currentMarkdown, proposedMarkdown,
		});
	};

	const tools = buildTools(propose);
	mcpServer = new AriaNotesMcpServer(tools);

	// Kick the server off before the first await so reregisterMcp can await it
	// even when the workbench calls while we're still in beginTracking. The
	// no-op catch only keeps an early rejection from going unhandled in that
	// window; the real error is reported where the IIFE awaits below.
	const startPromise = mcpServer.start();
	startPromise.catch(() => { /* handled below */ });

	void (async () => {
		await vscode.commands.executeCommand('aria.startup.beginTracking', 'aria-notes-mcp');
		let summary = 'Notes MCP - already configured';
		let changed = false;
		try {
			const port = await startPromise;
			console.log(`[aria-notes] MCP up on ${port}`);
			summary = `Notes MCP up on ${port}`;
		} catch (e) {
			summary = `Notes MCP startup failed: ${(e as Error).message}`;
			changed = false;
		} finally {
			await vscode.commands.executeCommand('aria.startup.markComplete', 'aria-notes-mcp', summary, changed);
		}
	})();

	// Sole registration entry point: the workbench chat-open coordinator calls
	// this (serialized across every Aria MCP) so the concurrent `claude mcp add`
	// writes that used to clobber ~/.claude.json can't happen. Returns true if it
	// newly registered something. Awaits the server start (rather than reading a
	// port set by the IIFE) because the coordinator may call before the port is
	// known - and whichever awaiter the runtime resumes first must still work.
	context.subscriptions.push(vscode.commands.registerCommand('aria.notes.reregisterMcp', async () => {
		const port = await startPromise.catch(() => undefined);
		if (port === undefined) { return false; }
		return (await registerAllProviders(port)).changed;
	}));
}

export async function deactivate(): Promise<void> {
	console.log('[aria-notes] deactivate()');
	if (mcpServer) {
		await mcpServer.stop();
		mcpServer = undefined;
	}
}
