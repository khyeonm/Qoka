/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * "Qoka setup ready" signal.
 *
 * Qoka's MCP servers (aria-paper, aria-notes, …) boot during extension
 * activation and register with Claude Code. The Claude chat connects to MCP
 * when its session starts - and if a previous session is RESTORED on window
 * load, it connects before those servers are up, leaving them "Failed" until a
 * manual /mcp reconnect.
 *
 * The first-run overlay already waits for every MCP tracker to finish before it
 * clears the workbench. It calls `markAriaSetupReady()` at that moment; the chat
 * session handler awaits `whenAriaSetupReady()` before starting/restoring a
 * session, so the session's MCP connection never happens before setup is done.
 *
 * A bounded timeout guarantees the chat is never blocked indefinitely if setup
 * never reports complete (matching the overlay's own hard cap).
 */

let resolved = false;
let resolveReady: () => void;
const ready = new Promise<void>(r => { resolveReady = r; });

/** True once the first-run tracker has fired markAriaSetupReady (not via a timeout). */
export function isAriaSetupReady(): boolean {
	return resolved;
}

/** Startup-timing diagnostics: the first-run tracker registers a reporter of what is
 *  still pending, so the loader can log WHICH tracker held it up when it times out. */
let pendingReporter: (() => string) | undefined;
export function setSetupPendingReporter(fn: () => string): void {
	pendingReporter = fn;
}
export function describeSetupPending(): string {
	try { return pendingReporter ? pendingReporter() : '(no tracker reporter registered)'; } catch { return '(reporter failed)'; }
}

/** Called by the first-run overlay once setup (all MCP servers) is complete. */
export function markAriaSetupReady(): void {
	if (!resolved) {
		resolved = true;
		resolveReady();
		markAriaMcpServersReady();
	}
}

// "MCP SERVERS started" signal: every MCP tracker has reported, IGNORING the Windows
// WSL/Ubuntu setup tracker. markAriaSetupReady also waits for that tracker (it holds
// the overlay through the Ubuntu install and account window), but MCP registration
// does not need WSL at all, so ariaStartupChat waits on THIS instead and registers
// in parallel with the WSL setup. Fired by the first-run tracker; markAriaSetupReady
// implies it.
let mcpServersReady = false;
let resolveMcpServersReady: () => void;
const mcpServersReadyPromise = new Promise<void>(r => { resolveMcpServersReady = r; });

export function markAriaMcpServersReady(): void {
	if (!mcpServersReady) {
		mcpServersReady = true;
		resolveMcpServersReady();
	}
}

export function isAriaMcpServersReady(): boolean {
	return mcpServersReady;
}

/** Resolves when every MCP server tracker has reported (WSL setup not included), or
 *  after `timeoutMs` as a safety net. */
export function whenAriaMcpServersReady(timeoutMs = 60000): Promise<void> {
	if (mcpServersReady) {
		return Promise.resolve();
	}
	return Promise.race([
		mcpServersReadyPromise,
		new Promise<void>(r => setTimeout(r, timeoutMs)),
	]);
}

// Separate "MCP REGISTRATION written" signal. markAriaSetupReady fires when the MCP
// SERVERS have STARTED (bound ports) - but the per-window config that maps the chat
// to those ports is WRITTEN a step later, by ariaStartupChat's registration pass. A
// chat that connected on markAriaSetupReady therefore raced ahead of its own config
// and showed every server "failed" until a manual /mcp reconnect. The chat session
// handler now waits for THIS signal instead, which ariaStartupChat fires only after
// registration has actually run. Per-renderer (per-window) module state.
let mcpRegistered = false;
let resolveMcpRegistered: () => void;
const mcpRegisteredReady = new Promise<void>(r => { resolveMcpRegistered = r; });

/** Called by ariaStartupChat once THIS window's MCP registration pass has run
 *  (config written), or was skipped (no usable CLI), so the chat never waits forever. */
export function markAriaMcpRegistered(): void {
	if (!mcpRegistered) {
		mcpRegistered = true;
		resolveMcpRegistered();
	}
}

/**
 * Resolves when Qoka setup is complete, or after `timeoutMs` as a safety net so
 * the chat can never be blocked forever. Resolves immediately if setup already
 * finished (the common case once the app has been running for a moment).
 */
export function whenAriaSetupReady(timeoutMs = 60000): Promise<void> {
	if (resolved) {
		return Promise.resolve();
	}
	return Promise.race([
		ready,
		new Promise<void>(r => setTimeout(r, timeoutMs)),
	]);
}

/**
 * Resolves when THIS window's MCP registration has run (config written), or after
 * `timeoutMs` as a safety net so the chat can never be blocked forever. The chat
 * session handler awaits this (not whenAriaSetupReady) before connecting to MCP, so
 * it never connects before its per-window server config exists.
 */
export function whenAriaMcpRegistered(timeoutMs = 60000): Promise<void> {
	if (mcpRegistered) {
		return Promise.resolve();
	}
	return Promise.race([
		mcpRegisteredReady,
		new Promise<void>(r => setTimeout(r, timeoutMs)),
	]);
}
