/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { buildTools } from './mcp/tools';
import { AriaOverviewMcpServer } from './mcp/server';
import { registerWithClaudeCode } from './registration/claudeCodeMcp';
import { registerWithCodex } from './registration/codexMcp';

let mcpServer: AriaOverviewMcpServer | undefined;

/**
 * Register the overview MCP with every AI provider whose CLI is available. The
 * server serves both /sse (Claude) and /mcp (Codex) on one port; each provider
 * is pointed at the endpoint it understands. A missing CLI is silently skipped.
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
			console.log(`[aria-overview] ${labels[i]}: ${r.value.message}`);
			if (r.value.ok) {
				registered.push(labels[i]);
				if (r.value.changed) { changed = true; }
			}
		} else {
			console.warn(`[aria-overview] ${labels[i]} registration threw:`, r.reason);
		}
	});
	const summary = registered.length
		? `Overview MCP registered with ${registered.join(', ')}`
		: 'Overview MCP - no AI provider CLI found yet';
	return { changed, summary };
}

/**
 * Aria Project Overview - boots a local MCP server so the AI assistant can read
 * the project's title / summary / To-do list and, when a task looks finished,
 * propose completions (which surface as Accept/Reject badges in the Project
 * Overview tab). Tools write <workspace>/.aria/overview.json directly; the tab
 * watches that file and refreshes.
 */
export function activate(context: vscode.ExtensionContext): void {
	console.log('[aria-overview] activate()');

	mcpServer = new AriaOverviewMcpServer(buildTools());

	let currentPort: number | undefined;

	void (async () => {
		await vscode.commands.executeCommand('aria.startup.beginTracking', 'aria-overview-mcp');
		let summary = 'Overview MCP - already configured';
		let changed = false;
		try {
			const port = await mcpServer!.start();
			currentPort = port;
			console.log(`[aria-overview] MCP up on ${port}; registering with AI providers…`);
			const reg = await registerAllProviders(port);
			changed = reg.changed;
			summary = reg.summary;
		} catch (e) {
			summary = `Overview MCP startup failed: ${(e as Error).message}`;
			changed = false;
		} finally {
			await vscode.commands.executeCommand('aria.startup.markComplete', 'aria-overview-mcp', summary, changed);
		}
	})();

	// Re-register when provider extensions are installed/removed later (debounced).
	let timer: NodeJS.Timeout | undefined;
	context.subscriptions.push(vscode.extensions.onDidChange(() => {
		if (currentPort === undefined) { return; }
		if (timer) { clearTimeout(timer); }
		timer = setTimeout(() => { void registerAllProviders(currentPort!); }, 800);
	}));

	// On-demand re-register for the workbench chat-open coordinator; true if it
	// newly registered something.
	context.subscriptions.push(vscode.commands.registerCommand('aria.overview.reregisterMcp', async () =>
		currentPort === undefined ? false : (await registerAllProviders(currentPort)).changed));
}

export async function deactivate(): Promise<void> {
	console.log('[aria-overview] deactivate()');
	if (mcpServer) {
		await mcpServer.stop();
		mcpServer = undefined;
	}
}
