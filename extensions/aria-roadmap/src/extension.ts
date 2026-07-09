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
import { registerWithCodex } from './registration/codexMcp';
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
/**
 * Register the roadmap MCP with every AI provider whose CLI is available
 * (Claude Code, Codex, Gemini). The server serves /sse (Claude) and /mcp
 * (Codex, Gemini) on the same port; missing CLIs are silently skipped.
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
			console.log(`[aria-roadmap] ${labels[i]}: ${r.value.message}`);
			if (r.value.ok) {
				registered.push(labels[i]);
				if (r.value.changed) { changed = true; }
			}
		} else {
			console.warn(`[aria-roadmap] ${labels[i]} registration threw:`, r.reason);
		}
	});
	const summary = registered.length
		? `Roadmap MCP registered with ${registered.join(', ')}`
		: 'Roadmap MCP — no AI provider CLI found yet';
	return { changed, summary };
}

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

	// Detect which AI assistant the user installed — do NOT force-install one.
	// Aria works with Claude Code, Codex, or Gemini; installing a specific one
	// (previously Claude) would fight a user who intentionally chose another.
	// The onboarding surface guides installation when none is present.
	void (async () => {
		await vscode.commands.executeCommand('aria.startup.beginTracking', 'aria-roadmap-claude-code-install');
		let summary = 'AI assistant ready';
		try {
			const providers = [
				{ id: 'anthropic.claude-code', name: 'Claude Code' },
				{ id: 'openai.chatgpt', name: 'Codex' },
				{ id: 'Google.gemini-cli-vscode-ide-companion', name: 'Gemini CLI' },
			];
			const installed = providers.filter(p => !!vscode.extensions.getExtension(p.id));
			summary = installed.length
				? `AI assistant detected: ${installed.map(p => p.name).join(', ')}`
				: 'No AI assistant installed yet — install Claude Code, Codex, or Gemini to use the chat.';
		} finally {
			await vscode.commands.executeCommand('aria.startup.markComplete', 'aria-roadmap-claude-code-install', summary, false);
		}
	})();

	let currentPort: number | undefined;

	void (async () => {
		await vscode.commands.executeCommand('aria.startup.beginTracking', 'aria-roadmap-mcp');
		let summary = 'Roadmap MCP — already configured';
		let changed = false;
		try {
			const port = await mcpServer!.start();
			currentPort = port;
			console.log(`[aria-roadmap] MCP up on ${port}; registering with AI providers…`);
			const reg = await registerAllProviders(port);
			changed = reg.changed;
			summary = reg.summary;
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

	// Re-register when provider extensions are installed/removed later, so a
	// provider added after startup still gets the roadmap MCP wired up without a
	// reload. Debounced because installs fire onDidChange rapidly.
	let timer: NodeJS.Timeout | undefined;
	context.subscriptions.push(vscode.extensions.onDidChange(() => {
		if (currentPort === undefined) { return; }
		if (timer) { clearTimeout(timer); }
		timer = setTimeout(() => { void registerAllProviders(currentPort!); }, 800);
	}));
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
