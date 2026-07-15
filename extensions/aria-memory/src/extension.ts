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
	return { changed, summary };
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

	let currentPort: number | undefined;

	void (async () => {
		await vscode.commands.executeCommand('aria.startup.beginTracking', 'aria-memory-mcp');
		let summary = 'Memory MCP - already configured';
		let changed = false;
		try {
			const port = await mcpServer!.start();
			currentPort = port;
			console.log(`[aria-memory] MCP up on ${port}; registering with AI providers…`);
			const reg = await registerAllProviders(port);
			changed = reg.changed;
			summary = reg.summary;
		} catch (e) {
			summary = `Memory MCP startup failed: ${(e as Error).message}`;
			changed = false;
		} finally {
			await vscode.commands.executeCommand('aria.startup.markComplete', 'aria-memory-mcp', summary, changed);
		}
	})();

	// Re-register when provider extensions are installed/removed later, so a
	// provider added after startup still gets the memory MCP wired up without
	// a reload. Debounced because installs fire onDidChange rapidly.
	let timer: NodeJS.Timeout | undefined;
	context.subscriptions.push(vscode.extensions.onDidChange(() => {
		if (currentPort === undefined) { return; }
		if (timer) { clearTimeout(timer); }
		timer = setTimeout(() => { void registerAllProviders(currentPort!); }, 800);
	}));
}

export async function deactivate(): Promise<void> {
	console.log('[aria-memory] deactivate()');
	if (mcpServer) {
		await mcpServer.stop();
		mcpServer = undefined;
	}
}
