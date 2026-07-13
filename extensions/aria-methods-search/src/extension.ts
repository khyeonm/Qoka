/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { AriaMethodsSearchMcpServer } from './mcp/server';
import { registerWithClaudeCode } from './registration/claudeCodeMcp';
import { registerWithCodex } from './registration/codexMcp';

/**
 * Methods Search extension entry. Boots the methods-search MCP server and
 * registers it with Claude Code + Codex. The MCP exposes recommend_methods /
 * search_hypotheses; both are read-only queries against the logic-graph Neo4j
 * on the Aria server (via the /api/methods endpoints), so there is nothing
 * destructive for the assistant to do and no sidebar to drive.
 */

let mcpServer: AriaMethodsSearchMcpServer | undefined;
let currentMcpPort: number | undefined;

/**
 * Register the methods-search MCP with every AI provider whose CLI is
 * available (Claude Code, Codex). The server serves /sse (Claude) and /mcp
 * (Codex) on the same port; missing CLIs are skipped. Returns whether any
 * registration actually changed.
 */
async function registerProviders(port: number): Promise<boolean> {
	const results = await Promise.allSettled([
		registerWithClaudeCode(port),
		registerWithCodex(port),
	]);
	const labels = ['Claude Code', 'Codex'];
	let changed = false;
	results.forEach((r, i) => {
		if (r.status === 'fulfilled') {
			console.log(`[aria-methods-search] ${labels[i]} registration ok=${r.value.ok} changed=${r.value.changed}: ${r.value.message}`);
			if (r.value.changed) { changed = true; }
		} else {
			console.error(`[aria-methods-search] ${labels[i]} registration threw:`, r.reason);
		}
	});
	return changed;
}

export function activate(context: vscode.ExtensionContext): void {
	console.log('[aria-methods-search] activate()');

	mcpServer = new AriaMethodsSearchMcpServer();

	// Start MCP + register with AI clients in the background. We don't block
	// activate(); registration proceeds while the rest of Aria loads.
	void bootMcp();

	// Re-register when provider extensions are installed/removed later, so a
	// provider added after startup still gets the methods-search MCP wired up
	// without a reload. Debounced because installs fire onDidChange rapidly.
	let timer: NodeJS.Timeout | undefined;
	context.subscriptions.push(vscode.extensions.onDidChange(() => {
		if (currentMcpPort === undefined) { return; }
		if (timer) { clearTimeout(timer); }
		timer = setTimeout(() => { void registerProviders(currentMcpPort!); }, 800);
	}));
}

async function bootMcp(): Promise<void> {
	if (!mcpServer) {
		return;
	}
	// Join the workbench startup overlay's tracking. The overlay stays up until
	// every tracked component reports complete, so the user can't poke Claude
	// Code mid-registration.
	await vscode.commands.executeCommand('aria.startup.beginTracking', 'aria-methods-search-mcp');
	let summary = 'Methods Search MCP — already configured';
	let changed = false;
	try {
		const port = await mcpServer.start();
		// Give the other Aria MCP extensions time to finish their own
		// `claude mcp add` before we start ours. The CLI doesn't lock its
		// config file, so concurrent writes can overwrite each other.
		await new Promise(resolve => setTimeout(resolve, 1500));
		console.log(`[aria-methods-search] MCP on ${port}; registering with AI clients`);
		currentMcpPort = port;
		changed = await registerProviders(port);
		console.log(`[aria-methods-search] final changed flag = ${changed}`);
		summary = changed
			? 'Methods Search MCP registered'
			: 'Methods Search MCP — already configured';
	} catch (err) {
		console.error('[aria-methods-search] MCP boot failed:', (err as Error).message);
		summary = `Methods Search MCP failed: ${(err as Error).message}`;
		changed = false;
	} finally {
		// Always report — drops us out of the tracking set so the overlay can
		// settle even when registration fails.
		await vscode.commands.executeCommand(
			'aria.startup.markComplete',
			'aria-methods-search-mcp',
			summary,
			changed,
		);
	}
}

export async function deactivate(): Promise<void> {
	console.log('[aria-methods-search] deactivate()');
	// Deliberately DO NOT unregister from Claude / Codex on shutdown — removing
	// the entry on every close means the next launch always re-adds and the UI
	// shows "registered" every time. The registration persists across runs so
	// the already-configured fast path can actually fire (same as paper-search).
	if (mcpServer) {
		await mcpServer.stop();
		mcpServer = undefined;
	}
}
