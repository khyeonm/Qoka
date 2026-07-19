/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { buildTools } from './mcp/tools';
import { AriaMemoryMcpServer } from './mcp/server';
import { registerWithClaudeCode } from './registration/claudeCodeMcp';
import { registerWithCodex } from './registration/codexMcp';
import { ensureNativeMemoryDisabled } from './nativeMemory';

let mcpServer: AriaMemoryMcpServer | undefined;

/**
 * Register the memory MCP with every AI provider whose CLI is available
 * (Claude Code, Codex). The server serves /sse (Claude) and /mcp
 * (Codex) on the same port; each provider is pointed at the endpoint
 * it understands. Missing CLIs are silently skipped.
 */
async function registerAllProviders(port: number): Promise<{ changed: boolean; registered: boolean; summary: string }> {
	const results = await Promise.allSettled([
		registerWithClaudeCode(port),
		registerWithCodex(port),
	]);
	const labels = ['Claude Code', 'Codex'];
	const registered: string[] = [];
	let changed = false;
	results.forEach((r, i) => {
		if (r.status === 'fulfilled') {
			console.log(`[aria-memory] ${labels[i]}: ${r.value.message}`);
			if (r.value.ok) {
				registered.push(labels[i]);
				if (r.value.changed) { changed = true; }
			}
		} else {
			console.warn(`[aria-memory] ${labels[i]} registration threw:`, r.reason);
		}
	});
	const summary = registered.length
		? `Memory MCP registered with ${registered.join(', ')}`
		: 'Memory MCP - no AI provider CLI found yet';
	return { changed, registered: registered.length > 0, summary };
}

/**
 * Aria Memory - boots a local MCP server so Claude Code (and, later, Codex)
 * can read and write this project's long-term memory: a per-project "LLM
 * wiki" of Markdown pages under `<workspace>/.aria/memory/wiki/`.
 *
 * This is the first slice of the memory system. Still to come (separate
 * phases): the cross-project mem0 store + its tools, a background extractor
 * that captures memories automatically from the conversation, and a Memory
 * view / review queue in the workbench.
 */
export function activate(context: vscode.ExtensionContext): void {
	console.log('[aria-memory] activate()');

	// Turn off Claude's native auto-memory for this workspace so the aria-memory
	// tools are the sole memory store. Re-run when the folder changes so a newly
	// opened project also gets the setting before its first Claude session.
	ensureNativeMemoryDisabled();
	context.subscriptions.push(
		vscode.workspace.onDidChangeWorkspaceFolders(() => ensureNativeMemoryDisabled()),
	);

	const tools = buildTools();
	mcpServer = new AriaMemoryMcpServer(tools);

	// Kick the server off before the first await so reregisterMcp can await it
	// even when the workbench calls while we're still in beginTracking. The
	// no-op catch only keeps an early rejection from going unhandled in that
	// window; the real error is reported where the IIFE awaits below.
	const startPromise = mcpServer.start();
	startPromise.catch(() => { /* handled below */ });

	void (async () => {
		await vscode.commands.executeCommand('aria.startup.beginTracking', 'aria-memory-mcp');
		let summary = 'Memory MCP - already configured';
		let changed = false;
		try {
			const port = await startPromise;
			console.log(`[aria-memory] MCP up on ${port}`);
			summary = `Memory MCP up on ${port}`;
		} catch (e) {
			summary = `Memory MCP startup failed: ${(e as Error).message}`;
			changed = false;
		} finally {
			await vscode.commands.executeCommand('aria.startup.markComplete', 'aria-memory-mcp', summary, changed);
		}
	})();

	// Sole registration entry point, called by the workbench chat-open
	// coordinator. It calls every Aria MCP's reregister command one at a time, so
	// this is the only place that writes the provider CLI config - concurrent
	// `claude mcp add` calls used to clobber each other's entries. Returns true if
	// it newly registered something (drives one shared "open a new chat"). Awaits
	// the server start (rather than reading a port set by the IIFE) because the
	// coordinator may call before the port is known - and whichever awaiter the
	// runtime resumes first must still work.
	// Reports this MCP server's { name, port } for the startup coordinator's
	// batch config write (see aria.mcp.applyConfig).
	context.subscriptions.push(vscode.commands.registerCommand('aria.memory.mcpInfo', async () => {
		const port = await startPromise.catch(() => undefined);
		return port === undefined ? null : { name: 'aria-memory', port };
	}));

	context.subscriptions.push(vscode.commands.registerCommand('aria.memory.reregisterMcp', async () => {
		const port = await startPromise.catch(() => undefined);
		if (port === undefined) { return { changed: false, registered: false }; }
		const { changed, registered } = await registerAllProviders(port);
		return { changed, registered };
	}));
}

export async function deactivate(): Promise<void> {
	console.log('[aria-memory] deactivate()');
	if (mcpServer) {
		await mcpServer.stop();
		mcpServer = undefined;
	}
}
