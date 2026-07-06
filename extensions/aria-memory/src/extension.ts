/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { buildTools } from './mcp/tools';
import { AriaMemoryMcpServer } from './mcp/server';
import { registerWithClaudeCode } from './registration/claudeCodeMcp';
import { ensureNativeMemoryDisabled } from './nativeMemory';

let mcpServer: AriaMemoryMcpServer | undefined;

/**
 * Aria Memory — boots a local MCP server so Claude Code (and, later, Codex)
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

	void (async () => {
		await vscode.commands.executeCommand('aria.startup.beginTracking', 'aria-memory-mcp');
		let summary = 'Memory MCP — already configured';
		let changed = false;
		try {
			const port = await mcpServer!.start();
			console.log(`[aria-memory] MCP up on ${port}; registering with Claude Code…`);
			const reg = await registerWithClaudeCode(port);
			console.log(`[aria-memory] Claude Code: ${reg.message}`);
			changed = reg.changed;
			if (!reg.ok) {
				summary = `Memory MCP registration failed: ${reg.message}`;
			} else if (reg.changed) {
				summary = 'Memory MCP registered with Claude Code';
			} else {
				summary = 'Memory MCP — already configured';
			}
		} catch (e) {
			summary = `Memory MCP startup failed: ${(e as Error).message}`;
			changed = false;
		} finally {
			await vscode.commands.executeCommand('aria.startup.markComplete', 'aria-memory-mcp', summary, changed);
		}
	})();
}

export async function deactivate(): Promise<void> {
	console.log('[aria-memory] deactivate()');
	if (mcpServer) {
		await mcpServer.stop();
		mcpServer = undefined;
	}
}
