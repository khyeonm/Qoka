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

	// Kick the server off before the first await so reregisterMcp can await it
	// even when the workbench calls while we're still in beginTracking. The
	// no-op catch only keeps an early rejection from going unhandled in that
	// window; the real error is reported where the IIFE awaits below.
	const startPromise = mcpServer.start();
	startPromise.catch(() => { /* handled below */ });

	void (async () => {
		await vscode.commands.executeCommand('aria.startup.beginTracking', 'aria-overview-mcp');
		let summary = 'Overview MCP - already configured';
		let changed = false;
		try {
			const port = await startPromise;
			console.log(`[aria-overview] MCP up on ${port}`);
			summary = `Overview MCP up on ${port}`;
		} catch (e) {
			summary = `Overview MCP startup failed: ${(e as Error).message}`;
			changed = false;
		} finally {
			await vscode.commands.executeCommand('aria.startup.markComplete', 'aria-overview-mcp', summary, changed);
		}
	})();

	// Sole registration entry point: the workbench chat-open coordinator calls
	// this (serialized across every Aria MCP) so the concurrent `claude mcp add`
	// writes that used to clobber ~/.claude.json can't happen. Returns true if it
	// newly registered something. Awaits the server start (rather than reading a
	// port set by the IIFE) because the coordinator may call before the port is
	// known - and whichever awaiter the runtime resumes first must still work.
	context.subscriptions.push(vscode.commands.registerCommand('aria.overview.reregisterMcp', async () => {
		const port = await startPromise.catch(() => undefined);
		if (port === undefined) { return false; }
		return (await registerAllProviders(port)).changed;
	}));
}

export async function deactivate(): Promise<void> {
	console.log('[aria-overview] deactivate()');
	if (mcpServer) {
		await mcpServer.stop();
		mcpServer = undefined;
	}
}
