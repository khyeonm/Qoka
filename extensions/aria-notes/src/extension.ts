/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { buildTools } from './mcp/tools';
import { AriaNotesMcpServer } from './mcp/server';
import { registerWithClaudeCode } from './registration/claudeCodeMcp';

let mcpServer: AriaNotesMcpServer | undefined;

/**
 * Aria Notes — boots a local MCP server so Claude Code can read notes (as
 * Markdown) and propose edits. Edits are not written directly: the server
 * fires `aria.notes.workbench.onProposal`, and the workbench note editor shows
 * the change for the user to Accept/Reject.
 */
export function activate(_context: vscode.ExtensionContext): void {
	console.log('[aria-notes] activate()');

	const propose = (
		filePath: string,
		title: string,
		blocks: unknown[],
		currentMarkdown: string,
		proposedMarkdown: string,
	) => {
		void vscode.commands.executeCommand('aria.notes.workbench.onProposal', {
			filePath, title, blocks, currentMarkdown, proposedMarkdown,
		});
	};

	const tools = buildTools(propose);
	mcpServer = new AriaNotesMcpServer(tools);

	void (async () => {
		await vscode.commands.executeCommand('aria.startup.beginTracking', 'aria-notes-mcp');
		let summary = 'Notes MCP — already configured';
		let changed = false;
		try {
			const port = await mcpServer!.start();
			console.log(`[aria-notes] MCP up on ${port}; registering with Claude Code…`);
			const reg = await registerWithClaudeCode(port);
			console.log(`[aria-notes] Claude Code: ${reg.message}`);
			changed = reg.changed;
			if (!reg.ok) {
				summary = `Notes MCP registration failed: ${reg.message}`;
			} else if (reg.changed) {
				summary = 'Notes MCP registered with Claude Code';
			} else {
				summary = 'Notes MCP — already configured';
			}
		} catch (e) {
			summary = `Notes MCP startup failed: ${(e as Error).message}`;
			changed = false;
		} finally {
			await vscode.commands.executeCommand('aria.startup.markComplete', 'aria-notes-mcp', summary, changed);
		}
	})();
}

export async function deactivate(): Promise<void> {
	console.log('[aria-notes] deactivate()');
	if (mcpServer) {
		await mcpServer.stop();
		mcpServer = undefined;
	}
}
