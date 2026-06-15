/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { RoadmapState, RoadmapNode } from './state';
import { buildTools } from './mcp/tools';
import { AriaRoadmapMcpServer } from './mcp/server';
import { registerWithClaudeCode } from './registration/claudeCodeMcp';
import { ensureClaudeCodeInstalled } from './install/claudeCodeExtension';
import { registerWorkbenchCommands } from './commands';

let mcpServer: AriaRoadmapMcpServer | undefined;
let state: RoadmapState | undefined;
let finalized = false;

/**
 * Aria Roadmap — extension entry.
 *
 * Phase 1 scope:
 *  1. Boot the in-process RoadmapState.
 *  2. Start the MCP server and let it expose the roadmap tools.
 *  3. Hand the Claude Code MCP CLI a registration pointing at our port.
 *  4. Install the Anthropic Claude Code extension from the Marketplace
 *     when it isn't already present.
 *
 * Each of steps 3 and 4 participates in the firstRunOverlay setup
 * tracking, so the user sees a single "Setting up Aria" surface during
 * the very first launch and a "Setup complete" toast lists what
 * actually changed.
 */
export function activate(context: vscode.ExtensionContext): void {
	console.log('[aria-roadmap] activate()');

	state = new RoadmapState();
	// In a project window (a folder is open), hydrate from the saved roadmap
	// so the AI's get_tree() and the sidebar Roadmap view both reflect it.
	// In the empty wizard window there is no folder, so this is a no-op.
	hydrateFromWorkspace(state);
	const notify = () => {
		void vscode.commands.executeCommand(
			'aria.roadmap.workbench.onStateChange',
			{
				columnLabels: ['Goal', 'Milestone', 'Task', 'Detail'],
				...state!.snapshot(),
				finalized,
			},
		);
	};
	const tools = buildTools(state, notify, value => { finalized = value; });
	mcpServer = new AriaRoadmapMcpServer(tools);

	registerWorkbenchCommands(context, state, () => finalized, value => { finalized = value; });

	// Push the (possibly hydrated) state once so an already-open roadmap editor
	// — e.g. auto-opened on a fresh project window — renders the saved tree.
	notify();

	void (async () => {
		await vscode.commands.executeCommand('aria.startup.beginTracking', 'aria-roadmap-claude-code-install');
		let installSummary = 'Claude Code — already installed';
		let installChanged = false;
		try {
			const result = await ensureClaudeCodeInstalled();
			installSummary = result.summary;
			installChanged = result.changed;
		} catch (e) {
			installSummary = `Claude Code install failed: ${(e as Error).message}`;
		} finally {
			await vscode.commands.executeCommand(
				'aria.startup.markComplete',
				'aria-roadmap-claude-code-install',
				installSummary,
				installChanged,
			);
		}
	})();

	void (async () => {
		await vscode.commands.executeCommand('aria.startup.beginTracking', 'aria-roadmap-mcp');
		let summary = 'Roadmap MCP — already configured';
		let changed = false;
		try {
			const port = await mcpServer!.start();
			console.log(`[aria-roadmap] MCP up on ${port}; registering with Claude Code…`);
			const reg = await registerWithClaudeCode(port);
			console.log(`[aria-roadmap] Claude Code: ${reg.message}`);
			changed = reg.changed;
			if (!reg.ok) {
				summary = `Roadmap MCP registration failed: ${reg.message}`;
			} else if (reg.changed) {
				summary = 'Roadmap MCP registered with Claude Code';
			} else {
				summary = 'Roadmap MCP — already configured';
			}
		} catch (e) {
			summary = `Roadmap MCP startup failed: ${(e as Error).message}`;
			changed = false;
		} finally {
			await vscode.commands.executeCommand(
				'aria.startup.markComplete',
				'aria-roadmap-mcp',
				summary,
				changed,
			);
		}
	})();
}

/** Load `<workspace>/.aria/roadmap.json` into the in-memory state if present.
 *  Best-effort: a missing/invalid file just leaves the state empty. */
function hydrateFromWorkspace(state: RoadmapState): void {
	const folder = vscode.workspace.workspaceFolders?.[0];
	if (!folder) {
		return;
	}
	const filePath = path.join(folder.uri.fsPath, '.aria', 'roadmap.json');
	try {
		const raw = fs.readFileSync(filePath, 'utf8');
		const parsed = JSON.parse(raw) as { nodes?: RoadmapNode[] };
		if (Array.isArray(parsed.nodes)) {
			state.load(parsed.nodes);
		}
	} catch {
		// No roadmap saved for this project yet — leave state empty.
	}
}

export async function deactivate(): Promise<void> {
	console.log('[aria-roadmap] deactivate()');
	// Intentionally leave the Claude Code MCP registration in place on
	// shutdown — same pattern aria-autopipe uses. The next activate()
	// reads the registered port back and skips re-registration when it
	// matches our live port, so a reload-window cycle doesn't churn
	// Claude Code's MCP config (which would otherwise force Claude Code
	// to restart its MCP session every time the user reloads). A stale
	// entry (port changed while Aria was closed) self-heals on the next
	// launch because the port mismatch triggers a fresh registration.
	if (mcpServer) {
		await mcpServer.stop();
		mcpServer = undefined;
	}
	state = undefined;
}
