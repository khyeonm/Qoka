/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { buildTools } from './mcp/tools';
import { QokaSlidesMcpServer } from './mcp/server';
import { SlidesPanel } from './slidesPanel';
import { registerWithClaudeCode } from './registration/claudeCodeMcp';
import { registerWithCodex } from './registration/codexMcp';

let mcpServer: QokaSlidesMcpServer | undefined;

/**
 * Register the slides MCP with every AI provider whose CLI is available. The
 * server serves both /sse (Claude) and /mcp (Codex) on one port; each provider
 * is pointed at the endpoint it understands. A missing CLI is silently skipped.
 */
async function registerAllProviders(port: number): Promise<{ changed: boolean; registered: boolean }> {
	const results = await Promise.allSettled([
		registerWithClaudeCode(port),
		registerWithCodex(port),
	]);
	const labels = ['Claude Code', 'Codex'];
	let registered = false;
	let changed = false;
	results.forEach((r, i) => {
		if (r.status === 'fulfilled') {
			console.log(`[qoka-slides] ${labels[i]}: ${r.value.message}`);
			if (r.value.ok) {
				registered = true;
				if (r.value.changed) { changed = true; }
			}
		} else {
			console.warn(`[qoka-slides] ${labels[i]} registration threw:`, r.reason);
		}
	});
	return { changed, registered };
}

/**
 * Qoka Slides - boots a local MCP server so the AI assistant can build and edit
 * slide decks. Tools read/write <workspace>/.qoka/slides/<slug>/ directly; the
 * Slides tab watches those files and re-renders live.
 */
export function activate(context: vscode.ExtensionContext): void {
	console.log('[qoka-slides] activate()');

	context.subscriptions.push(vscode.commands.registerCommand('qoka.slides.open', () => SlidesPanel.open(context.extensionUri)));

	mcpServer = new QokaSlidesMcpServer(buildTools(context.extensionUri.fsPath));

	// Kick the server off before the first await so reregisterMcp can await it
	// even when the workbench coordinator calls while we're still starting.
	const startPromise = mcpServer.start();
	startPromise.catch(() => { /* handled below */ });

	void (async () => {
		await vscode.commands.executeCommand('aria.startup.beginTracking', 'qoka-slides-mcp');
		let summary = 'Slides MCP - already configured';
		let changed = false;
		try {
			const port = await startPromise;
			summary = `Slides MCP up on ${port}`;
		} catch (e) {
			summary = `Slides MCP startup failed: ${(e as Error).message}`;
			changed = false;
		} finally {
			await vscode.commands.executeCommand('aria.startup.markComplete', 'qoka-slides-mcp', summary, changed);
		}
	})();

	// Reports this MCP server's { name, port } for the startup coordinator's
	// batch config write (aria.mcp.applyConfig). Awaits the server start so a
	// coordinator call that arrives before the port is known still works.
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
