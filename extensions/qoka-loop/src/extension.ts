/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { buildTools } from './mcp/tools';
import { QokaLoopMcpServer } from './mcp/server';
import { registerWithClaudeCode } from './registration/claudeCodeMcp';
import { registerWithCodex } from './registration/codexMcp';
import * as fs from 'fs';
import { openLoopPanel, LOOP_FILE_SCHEME } from './ui/loopPanel';

let mcpServer: QokaLoopMcpServer | undefined;

/**
 * Register the loop MCP with every AI provider whose CLI is available. The server
 * serves both /sse (Claude) and /mcp (Codex) on one port; each provider is pointed at
 * the endpoint it understands. A missing CLI is silently skipped.
 */
async function registerAllProviders(port: number): Promise<{ changed: boolean; registered: boolean }> {
	const results = await Promise.allSettled([
		registerWithClaudeCode(port),
		registerWithCodex(port),
	]);
	const labels = ['Claude Code', 'Codex'];
	let changed = false;
	let registered = 0;
	results.forEach((r, i) => {
		if (r.status === 'fulfilled') {
			console.log(`[qoka-loop] ${labels[i]}: ${r.value.message}`);
			if (r.value.ok) { registered++; if (r.value.changed) { changed = true; } }
		} else {
			console.warn(`[qoka-loop] ${labels[i]} registration threw:`, r.reason);
		}
	});
	return { changed, registered: registered > 0 };
}

/**
 * Qoka Research Loop Engine - boots a local MCP server (qoka-loop) so the AI assistant
 * can design a research loop (design_loop) and persist it (save_loop) under
 * <project>/.qoka/loops. Execution of the loop (start_loop) lands in a later milestone;
 * for now this is design + persistence only.
 */
export function activate(context: vscode.ExtensionContext): void {
	console.log('[qoka-loop] activate()');

	mcpServer = new QokaLoopMcpServer(buildTools());

	// Kick the server off before the first await so reregisterMcp can await it even when
	// the workbench calls while we are still in beginTracking.
	const startPromise = mcpServer.start();
	startPromise.catch(() => { /* handled below */ });

	void (async () => {
		await vscode.commands.executeCommand('aria.startup.beginTracking', 'qoka-loop-mcp');
		let summary = 'Loop MCP - already configured';
		let changed = false;
		try {
			const port = await startPromise;
			console.log(`[qoka-loop] MCP up on ${port}`);
			summary = `Loop MCP up on ${port}`;
		} catch (e) {
			summary = `Loop MCP startup failed: ${(e as Error).message}`;
			changed = false;
		} finally {
			await vscode.commands.executeCommand('aria.startup.markComplete', 'qoka-loop-mcp', summary, changed);
		}
	})();

	// Sole registration entry point, serialized across every Qoka MCP by the workbench
	// chat-open coordinator. Reports this server's { name, port } for the batch config write.
	// Open (or reveal) the Qoka Loops tab. Invoked from the command palette, the left rail tab,
	// and from the chat tools right after a loop is saved/started (with the loop id to focus).
	context.subscriptions.push(vscode.commands.registerCommand('qoka.loop.open', (loopId?: string) => {
		openLoopPanel(context, typeof loopId === 'string' ? loopId : undefined);
	}));

	// Read-only virtual documents for the Loops tab's "Files" list. Loop artifacts live under the
	// hidden .qoka/loops/<id>/ folder; opening them through this scheme (rather than the real file
	// URI) shows the code read-only AND stops the Analysis explorer from auto-revealing/expanding
	// that hidden path. The real path is carried in the URI query; the visible path keeps the
	// filename so the editor still picks the right language.
	context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider(LOOP_FILE_SCHEME, {
		provideTextDocumentContent(uri: vscode.Uri): string {
			try { return fs.readFileSync(uri.query, 'utf8'); }
			catch (e) { return `Cannot read file: ${(e as Error).message}`; }
		},
	}));

	context.subscriptions.push(vscode.commands.registerCommand('qoka.loop.mcpInfo', async () => {
		const port = await startPromise.catch(() => undefined);
		return port === undefined ? null : { name: 'qoka-loop', port };
	}));

	context.subscriptions.push(vscode.commands.registerCommand('qoka.loop.reregisterMcp', async () => {
		const port = await startPromise.catch(() => undefined);
		if (port === undefined) { return { changed: false, registered: false }; }
		const { changed, registered } = await registerAllProviders(port);
		return { changed, registered };
	}));
}

export async function deactivate(): Promise<void> {
	console.log('[qoka-loop] deactivate()');
	if (mcpServer) {
		await mcpServer.stop();
		mcpServer = undefined;
	}
}
