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
// The MCP server's start(). reregisterMcp awaits this for the port, so a
// workbench call that lands before the server is listening still registers.
let startPromise: Promise<number> | undefined;

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

	// Start the MCP in the background. We don't block activate(); registration is
	// driven separately by the workbench (see the reregister command below).
	void bootMcp();

	// Sole registration entry point: the workbench chat-open coordinator calls
	// this (serialized across every Aria MCP) so the concurrent `claude mcp add`
	// writes that used to clobber ~/.claude.json can't happen. Returns true if it
	// newly registered something. Awaits the server start (rather than reading a
	// port set by bootMcp) because the coordinator may call before the port is
	// known - and whichever awaiter the runtime resumes first must still work.
	context.subscriptions.push(vscode.commands.registerCommand('aria.methodsSearch.reregisterMcp', async () => {
		const port = await startPromise?.catch(() => undefined);
		if (port === undefined) { return false; }
		return registerProviders(port);
	}));
}

async function bootMcp(): Promise<void> {
	if (!mcpServer) {
		return;
	}
	// Kick the server off before the first await so reregisterMcp can await it
	// even when the workbench calls while we're still in beginTracking. The
	// no-op catch only keeps an early rejection from going unhandled in that
	// window; the real error is reported where we await below.
	startPromise = mcpServer.start();
	startPromise.catch(() => { /* handled below */ });

	// Join the workbench startup overlay's tracking. The overlay stays up until
	// every tracked component reports complete, so the user can't poke Claude
	// Code mid-registration.
	await vscode.commands.executeCommand('aria.startup.beginTracking', 'aria-methods-search-mcp');
	let summary = 'Methods Search MCP - already configured';
	let changed = false;
	try {
		const port = await startPromise;
		console.log(`[aria-methods-search] MCP on ${port}`);
		summary = `Methods Search MCP up on ${port}`;
	} catch (err) {
		console.error('[aria-methods-search] MCP boot failed:', (err as Error).message);
		summary = `Methods Search MCP failed: ${(err as Error).message}`;
		changed = false;
	} finally {
		// Always report - drops us out of the tracking set so the overlay can
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
	// Deliberately DO NOT unregister from Claude / Codex on shutdown - removing
	// the entry on every close means the next launch always re-adds and the UI
	// shows "registered" every time. The registration persists across runs so
	// the already-configured fast path can actually fire (same as paper-search).
	if (mcpServer) {
		await mcpServer.stop();
		mcpServer = undefined;
	}
}
