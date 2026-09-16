/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { buildTools } from './mcp/tools';
import { QokaSlidesMcpServer } from './mcp/server';
import { registerWithClaudeCode } from './registration/claudeCodeMcp';
import { registerWithCodex } from './registration/codexMcp';

let mcpServer: QokaSlidesMcpServer | undefined;

async function registerAllProviders(port: number): Promise<{ changed: boolean; registered: boolean }> {
	const results = await Promise.allSettled([registerWithClaudeCode(port), registerWithCodex(port)]);
	const labels = ['Claude Code', 'Codex'];
	let registered = false;
	let changed = false;
	results.forEach((r, i) => {
		if (r.status === 'fulfilled') {
			console.log(`[qoka-slides] ${labels[i]}: ${r.value.message}`);
			if (r.value.ok) { registered = true; if (r.value.changed) { changed = true; } }
		} else {
			console.warn(`[qoka-slides] ${labels[i]} registration threw:`, r.reason);
		}
	});
	return { changed, registered };
}

export function activate(context: vscode.ExtensionContext): void {
	console.log('[qoka-slides] activate()');
	const extUri = context.extensionUri;

	// --- MCP server ----------------------------------------------------------
	// The qoka-slides MCP is only a bridge to the Slides tab (the whirick web app);
	// decks are created and edited through whirick's own MCP, so there are no local
	// deck commands here any more.
	mcpServer = new QokaSlidesMcpServer(buildTools(extUri.fsPath));
	const startPromise = mcpServer.start();
	startPromise.catch(() => { /* handled below */ });

	void (async () => {
		await vscode.commands.executeCommand('aria.startup.beginTracking', 'qoka-slides-mcp');
		let summary = 'Slides MCP - already configured';
		try {
			const port = await startPromise;
			summary = `Slides MCP up on ${port}`;
		} catch (e) {
			summary = `Slides MCP startup failed: ${(e as Error).message}`;
		} finally {
			await vscode.commands.executeCommand('aria.startup.markComplete', 'qoka-slides-mcp', summary, false);
		}
	})();

	context.subscriptions.push(vscode.commands.registerCommand('aria.slides.mcpInfo', async () => {
		const port = await startPromise.catch(() => undefined);
		return port === undefined ? null : { name: 'qoka-slides', port };
	}));

	context.subscriptions.push(vscode.commands.registerCommand('aria.slides.reregisterMcp', async () => {
		const port = await startPromise.catch(() => undefined);
		if (port === undefined) { return { changed: false, registered: false }; }
		return registerAllProviders(port);
	}));
}

export async function deactivate(): Promise<void> {
	console.log('[qoka-slides] deactivate()');
	if (mcpServer) {
		await mcpServer.stop();
		mcpServer = undefined;
	}
}
