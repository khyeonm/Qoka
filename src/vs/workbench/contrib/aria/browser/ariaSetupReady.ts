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

/** Called by the first-run overlay once setup (all MCP servers) is complete. */
export function markAriaSetupReady(): void {
	if (!resolved) {
		resolved = true;
		resolveReady();
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
