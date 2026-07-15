/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { AriaHypothesisMcpServer } from './mcp/server';
import { registerWithClaudeCode } from './registration/claudeCodeMcp';
import { registerWithCodex } from './registration/codexMcp';

/**
 * Hypothesis Search extension entry. Boots the hypothesis MCP server and
 * registers it with Claude Code + Codex. Pure MCP - no sidebar/commands.
 *
 * The MCP exposes search_hypothesis (grep the corpus) and
 * get_hypothesis_fulltext (wider read). The actual corpus lives on the
 * Aria server; the tools call its JWT-protected /api/hypothesis endpoints
 * (see client.ts), so the corpus is never shipped or touched locally.
 */

let mcpServer: AriaHypothesisMcpServer | undefined;
let currentMcpPort: number | undefined;

/**
 * Register the hypothesis MCP with every AI provider whose CLI is
 * available (Claude Code, Codex). The server serves /sse (Claude) and
 * /mcp (Codex) on the same port; missing CLIs are skipped. Returns
 * whether any registration actually changed.
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
			console.log(`[aria-hypothesis] ${labels[i]} registration ok=${r.value.ok} changed=${r.value.changed}: ${r.value.message}`);
			if (r.value.changed) { changed = true; }
		} else {
			console.error(`[aria-hypothesis] ${labels[i]} registration threw:`, r.reason);
		}
	});
	return changed;
}

export function activate(context: vscode.ExtensionContext): void {
	console.log('[aria-hypothesis] activate()');

	mcpServer = new AriaHypothesisMcpServer();

	// Start MCP + register with AI clients in the background; don't block activate().
	void bootMcp();

	// Re-register when provider extensions are installed/removed later, so a
	// provider added after startup still gets the hypothesis MCP wired up
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
	// Join the workbench startup overlay's tracking so the user can't poke
	// Claude Code mid-registration.
	await vscode.commands.executeCommand('aria.startup.beginTracking', 'aria-hypothesis-mcp');
	let summary = 'Hypothesis Search MCP - already configured';
	let changed = false;
	try {
		const port = await mcpServer.start();
		// Give other extensions racing us to the claude CLI time to finish
		// their own `claude mcp add`; the CLI doesn't lock its config file.
		await new Promise(resolve => setTimeout(resolve, 1500));
		console.log(`[aria-hypothesis] MCP on ${port}; registering with AI clients`);
		currentMcpPort = port;
		changed = await registerProviders(port);
		summary = changed
			? 'Hypothesis Search MCP registered'
			: 'Hypothesis Search MCP - already configured';
	} catch (err) {
		console.error('[aria-hypothesis] MCP boot failed:', (err as Error).message);
		summary = `Hypothesis Search MCP failed: ${(err as Error).message}`;
		changed = false;
	} finally {
		await vscode.commands.executeCommand(
			'aria.startup.markComplete',
			'aria-hypothesis-mcp',
			summary,
			changed,
		);
	}
}

export async function deactivate(): Promise<void> {
	console.log('[aria-hypothesis] deactivate()');
	// Deliberately DO NOT unregister from Claude / Codex on shutdown - the
	// registration persists across runs (same pattern as the other Aria MCPs).
	if (mcpServer) {
		await mcpServer.stop();
		mcpServer = undefined;
	}
}
