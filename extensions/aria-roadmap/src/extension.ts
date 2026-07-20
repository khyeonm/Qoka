/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { RoadmapState } from './state';
import { RoadmapStore } from './roadmaps';
import { buildTools } from './mcp/tools';
import { AriaRoadmapMcpServer } from './mcp/server';
import { registerWithClaudeCode } from './registration/claudeCodeMcp';
import { registerWithCodex } from './registration/codexMcp';
import { registerWorkbenchCommands, snapshotPayload } from './commands';

let mcpServer: AriaRoadmapMcpServer | undefined;
let store: RoadmapStore | undefined;
let finalized = false;
// Reveal the Roadmap view container at most once per server session so a
// proposed node is never added to a canvas the user cannot see, without
// stealing focus on every single node.
let canvasRevealed = false;

/**
 * Qoka Roadmap - extension entry.
 *
 * Phase 1 scope:
 *  1. Boot the in-process RoadmapState.
 *  2. Start the MCP server and let it expose the roadmap tools.
 *  3. Hand the Claude Code MCP CLI a registration pointing at our port.
 *  4. Install the Anthropic Claude Code extension from the Marketplace
 *     when it isn't already present.
 *
 * Each of steps 3 and 4 participates in the firstRunOverlay setup
 * tracking, so the user sees a single "Setting up Qoka" surface during
 * the very first launch and a "Setup complete" toast lists what
 * actually changed.
 */
/**
 * Register the roadmap MCP with every AI provider whose CLI is available
 * (Claude Code, Codex). The server serves /sse (Claude) and /mcp
 * (Codex) on the same port; missing CLIs are silently skipped.
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
		: 'Roadmap MCP - no AI provider CLI found yet';
	return { changed, registered: registered.length > 0, summary };
}

export function activate(context: vscode.ExtensionContext): void {
	console.log('[aria-roadmap] activate()');

	const state = new RoadmapState();
	// In a project window (a folder is open), the store manages every roadmap
	// under `.aria/roadmaps/` and mirrors the ACTIVE one into `state`. Migrate a
	// legacy single roadmap.json and make sure something is active so get_tree()
	// and the canvas have a roadmap to show. In the empty wizard window there is
	// no folder, so the store is folder-less and these are no-ops.
	const workspaceFsPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	store = new RoadmapStore(state, workspaceFsPath);
	store.migrateLegacy();
	store.ensureActive();
	const notify = () => {
		void vscode.commands.executeCommand(
			'aria.roadmap.workbench.onStateChange',
			snapshotPayload(store!, finalized),
		);
	};
	// Best-effort: reveal the Roadmap view container so nodes are never proposed
	// onto a canvas the user cannot see. Revealing the container is idempotent
	// and cheap; guarded to fire once per session to avoid stealing focus on
	// every node. Mirrors aria-overview's open_roadmap container reveal.
	const ensureCanvasOpen = () => {
		if (canvasRevealed) { return; }
		canvasRevealed = true;
		try {
			void vscode.commands.executeCommand('workbench.view.ariaRoadmap');
		} catch { /* no UI (headless / registration-only) - best-effort */ }
	};
	const tools = buildTools(store, notify, value => { finalized = value; }, ensureCanvasOpen);
	mcpServer = new AriaRoadmapMcpServer(tools);

	registerWorkbenchCommands(context, store, () => finalized, value => { finalized = value; });

	// Push the (possibly hydrated) state once so an already-open roadmap editor
	// - e.g. auto-opened on a fresh project window - renders the saved tree.
	notify();

	// Detect which AI assistant the user installed - do NOT force-install one.
	// Qoka works with Claude Code or Codex; installing a specific one
	// (previously Claude) would fight a user who intentionally chose another.
	// The onboarding surface guides installation when none is present.
	void (async () => {
		await vscode.commands.executeCommand('aria.startup.beginTracking', 'aria-roadmap-claude-code-install');
		let summary = 'AI assistant ready';
		try {
			const providers = [
				{ id: 'anthropic.claude-code', name: 'Claude Code' },
				{ id: 'openai.chatgpt', name: 'Codex' },
			];
			const installed = providers.filter(p => !!vscode.extensions.getExtension(p.id));
			summary = installed.length
				? `AI assistant detected: ${installed.map(p => p.name).join(', ')}`
				: 'No AI assistant installed yet - install Claude Code or Codex to use the chat.';
		} finally {
			await vscode.commands.executeCommand('aria.startup.markComplete', 'aria-roadmap-claude-code-install', summary, false);
		}
	})();

	// Kick the server off before the first await so reregisterMcp can await it
	// even when the workbench calls while we're still in beginTracking. The
	// no-op catch only keeps an early rejection from going unhandled in that
	// window; the real error is reported where the IIFE awaits below.
	const startPromise = mcpServer.start();
	startPromise.catch(() => { /* handled below */ });

	void (async () => {
		await vscode.commands.executeCommand('aria.startup.beginTracking', 'aria-roadmap-mcp');
		let summary = 'Roadmap MCP - already configured';
		let changed = false;
		try {
			const port = await startPromise;
			console.log(`[aria-roadmap] MCP up on ${port}`);
			summary = `Roadmap MCP up on ${port}`;
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

	// Sole registration entry point: the workbench chat-open coordinator calls
	// this (serialized across every Qoka MCP) so the concurrent `claude mcp add`
	// writes that used to clobber ~/.claude.json can't happen. Returns true if it
	// newly registered something. Awaits the server start (rather than reading a
	// port set by the IIFE) because the coordinator may call before the port is
	// known - and whichever awaiter the runtime resumes first must still work.
	// Reports this MCP server's { name, port } for the startup coordinator's
	// batch config write (see aria.mcp.applyConfig).
	context.subscriptions.push(vscode.commands.registerCommand('aria.roadmap.mcpInfo', async () => {
		const port = await startPromise.catch(() => undefined);
		return port === undefined ? null : { name: 'qoka-roadmap', port };
	}));

	context.subscriptions.push(vscode.commands.registerCommand('aria.roadmap.reregisterMcp', async () => {
		const port = await startPromise.catch(() => undefined);
		if (port === undefined) { return { changed: false, registered: false }; }
		const { changed, registered } = await registerAllProviders(port);
		return { changed, registered };
	}));
}

export async function deactivate(): Promise<void> {
	console.log('[aria-roadmap] deactivate()');
	// Intentionally leave the Claude Code MCP registration in place on
	// shutdown - same pattern aria-autopipe uses. The next activate()
	// reads the registered port back and skips re-registration when it
	// matches our live port, so a reload-window cycle doesn't churn
	// Claude Code's MCP config (which would otherwise force Claude Code
	// to restart its MCP session every time the user reloads). A stale
	// entry (port changed while Qoka was closed) self-heals on the next
	// launch because the port mismatch triggers a fresh registration.
	if (mcpServer) {
		await mcpServer.stop();
		mcpServer = undefined;
	}
	store = undefined;
}
