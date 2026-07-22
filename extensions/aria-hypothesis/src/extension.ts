/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { AriaHypothesisMcpServer } from './mcp/server';
import { registerWithClaudeCode } from './registration/claudeCodeMcp';
import { registerWithCodex } from './registration/codexMcp';

/**
 * Hypothesis Search extension entry. Boots the qoka-hypothesis MCP server and
 * registers it with Claude Code + Codex. Pure MCP - no sidebar/commands.
 *
 * The MCP exposes search_hypothesis (grep the corpus) and
 * get_hypothesis_fulltext (wider read). The actual corpus lives on the
 * Qoka server; the tools call its JWT-protected /api/hypothesis endpoints
 * (see client.ts), so the corpus is never shipped or touched locally.
 */

let mcpServer: AriaHypothesisMcpServer | undefined;
// The MCP server's start(). reregisterMcp awaits this for the port, so a
// workbench call that lands before the server is listening still registers.
let startPromise: Promise<number> | undefined;

/**
 * Register the qoka-hypothesis MCP with every AI provider whose CLI is
 * available (Claude Code, Codex). The server serves /sse (Claude) and
 * /mcp (Codex) on the same port; missing CLIs are skipped. Returns
 * whether any registration actually changed.
 */
async function registerProviders(port: number): Promise<{ changed: boolean; registered: boolean }> {
	const results = await Promise.allSettled([
		registerWithClaudeCode(port),
		registerWithCodex(port),
	]);
	const labels = ['Claude Code', 'Codex'];
	let changed = false;
	let registered = false;
	results.forEach((r, i) => {
		if (r.status === 'fulfilled') {
			console.log(`[aria-hypothesis] ${labels[i]} registration ok=${r.value.ok} changed=${r.value.changed}: ${r.value.message}`);
			if (r.value.ok) { registered = true; }
			if (r.value.changed) { changed = true; }
		} else {
			console.error(`[aria-hypothesis] ${labels[i]} registration threw:`, r.reason);
		}
	});
	return { changed, registered };
}

export function activate(context: vscode.ExtensionContext): void {
	console.log('[aria-hypothesis] activate()');

	mcpServer = new AriaHypothesisMcpServer();

	// Start the MCP in the background; don't block activate(). Registration is
	// driven separately by the workbench (see the reregister command below).
	void bootMcp();

	// Sole registration entry point: the workbench chat-open coordinator calls
	// this (serialized across every Qoka MCP) so the concurrent `claude mcp add`
	// writes that used to clobber ~/.claude.json can't happen. Returns true if it
	// newly registered something. Awaits the server start (rather than reading a
	// port set by bootMcp) because the coordinator may call before the port is
	// known - and whichever awaiter the runtime resumes first must still work.
	// Reports this MCP server's { name, port } for the startup coordinator's
	// batch config write (see aria.mcp.applyConfig).
	context.subscriptions.push(vscode.commands.registerCommand('aria.hypothesis.mcpInfo', async () => {
		const port = await startPromise?.catch(() => undefined);
		return port === undefined ? null : { name: 'qoka-hypothesis', port };
	}));

	context.subscriptions.push(vscode.commands.registerCommand('aria.hypothesis.reregisterMcp', async () => {
		const port = await startPromise?.catch(() => undefined);
		if (port === undefined) { return { changed: false, registered: false }; }
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

	// Join the workbench startup overlay's tracking so the user can't poke
	// Claude Code mid-registration.
	await vscode.commands.executeCommand('aria.startup.beginTracking', 'aria-hypothesis-mcp');
	let summary = 'Hypothesis Search MCP - already configured';
	let changed = false;
	try {
		const port = await startPromise;
		console.log(`[aria-hypothesis] MCP on ${port}`);
		summary = `Hypothesis Search MCP up on ${port}`;
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
	// registration persists across runs (same pattern as the other Qoka MCPs).
	if (mcpServer) {
		await mcpServer.stop();
		mcpServer = undefined;
	}
}
