/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { exec } from 'child_process';
import { promisify } from 'util';
import { candidateCodexPaths } from '../detection/claudeCodeDetector';

const execAsync = promisify(exec);

// Use the same name as Claude Code's registration so saved prompts referring
// to "autopipe" tools work in either client without modification.
const MCP_NAME = 'autopipe';
const LEGACY_MCP_NAME = 'aria-autopipe';

/**
 * Resolve which `codex` binary to drive. Tries the shell PATH first, then
 * probes well-known install locations the VS Code launcher's sparse PATH
 * often misses (nvm node bins, Homebrew, etc.). Returns null when no Codex
 * CLI is reachable.
 */
async function resolveCodexBinary(): Promise<string | null> {
	try {
		await execAsync('codex --version', { timeout: 5000 });
		return 'codex';
	} catch {
		// fall through to candidates
	}
	for (const candidate of candidateCodexPaths()) {
		try {
			await execAsync(`"${candidate}" --version`, { timeout: 5000 });
			return candidate;
		} catch {
			// try next
		}
	}
	return null;
}

export interface RegistrationResult {
	ok: boolean;
	message: string;
	/**
	 * True when this run actually (re)wrote the registration; false when it was
	 * skipped because Codex already pointed at our live port.
	 */
	changed: boolean;
}

/**
 * Read the port Codex currently has registered for `autopipe`, or null when it
 * isn't registered / can't be read. Codex exposes no `mcp get`, so we parse
 * `codex mcp list` for the autopipe entry (excluding the legacy name) and pull
 * the 127.0.0.1 port from it or the couple of lines that follow.
 */
async function readCodexRegisteredPort(codex: string, name: string): Promise<number | null> {
	try {
		const out = await execAsync(`${quoteArg(codex)} mcp list`, { timeout: 10000 });
		const lines = out.stdout.split('\n');
		const wanted = name.toLowerCase();
		for (let i = 0; i < lines.length; i++) {
			const t = lines[i].trim().toLowerCase();
			// Match the wanted name; for the base `autopipe` entry, don't confuse it
			// with the legacy `aria-autopipe`.
			const hit = t.includes(wanted) && (name !== MCP_NAME || !t.includes('aria-autopipe'));
			if (hit) {
				for (let j = i; j < Math.min(i + 3, lines.length); j++) {
					const m = lines[j].match(/127\.0\.0\.1:(\d+)/);
					if (m) {
						return parseInt(m[1], 10);
					}
				}
			}
		}
		return null;
	} catch {
		return null;
	}
}

/**
 * (Re-)register Qoka's MCP server with the Codex CLI so Codex advertises
 * Autopipe's tools in every new conversation. Mirrors the Claude Code
 * registration flow: clear any stale entry first (the port can change
 * between Qoka runs), then `codex mcp add ... --url <url>` for the
 * streamable-HTTP transport, then verify with `codex mcp list`.
 *
 * Codex CLI syntax (v0.125+):
 *   codex mcp add <NAME> --url <URL>
 *   codex mcp remove <NAME>
 *   codex mcp list
 */
export async function registerWithCodex(port: number, name: string = MCP_NAME): Promise<RegistrationResult> {
	console.log(`[aria-autopipe] registerWithCodex(name=${name}, port=${port}) starting`);
	const codex = await resolveCodexBinary();
	if (!codex) {
		console.error('[aria-autopipe] Codex CLI not found in PATH or candidate locations');
		return {
			ok: false,
			changed: false,
			message: 'Codex CLI not found on PATH or known install locations. '
				+ 'Make sure the Codex extension is installed; it ships the CLI. '
				+ 'If installed, ensure your shell PATH includes the directory containing the codex binary.',
		};
	}
	console.log(`[aria-autopipe] Codex CLI resolved to: ${codex}`);

	// Codex uses the Streamable HTTP transport (MCP protocol 2025-03-26+),
	// not HTTP+SSE. Qoka's MCP server exposes that on /mcp, separate from
	// the /sse endpoint Claude Code uses.
	const url = `http://127.0.0.1:${port}/mcp`;
	const q = quoteArg(codex);

	// Skip the rewrite (and the "reload the window" nudge) when Codex already
	// points at our live port. A different port means a stale entry from a
	// previous run; this port means it already targets the server we started.
	const existingPort = await readCodexRegisteredPort(codex, name);
	if (existingPort === port) {
		console.log(`[aria-autopipe] Codex already registered "${name}" on port ${port}; skipping re-registration`);
		return { ok: true, changed: false, message: `Already registered -> ${url}` };
	}

	// Best-effort removal of prior entries - including the legacy name for the
	// autopipe server - so the next add lands clean. Codex doesn't expose
	// per-scope MCP configs (one user-level config.toml), so a single remove per
	// name is enough.
	const rmNames = name === MCP_NAME ? [MCP_NAME, LEGACY_MCP_NAME] : [name];
	for (const rmName of rmNames) {
		try {
			const out = await execAsync(`${q} mcp remove ${rmName}`, { timeout: 10000 });
			console.log(`[aria-autopipe] removed prior Codex MCP entry "${rmName}":`, out.stdout.trim());
		} catch (err) {
			// Codex returns non-zero when the entry doesn't exist - expected
			// on first run.
			console.log(`[aria-autopipe] no prior Codex MCP entry "${rmName}":`, (err as Error).message);
		}
	}

	const addCmd = `${q} mcp add ${name} --url ${quoteArg(url)}`;
	console.log(`[aria-autopipe] running: ${addCmd}`);
	// Qoka's many extensions run `codex mcp add` concurrently, all writing the one
	// ~/.codex/config.toml. On Windows they collide on the file lock and fail with
	// "failed to persist config ... (os error 5 / access denied)". Retry a few
	// times with jittered backoff so contending writers each succeed in turn.
	let addErr = '';
	for (let attempt = 0; attempt < 5; attempt++) {
		try {
			const out = await execAsync(addCmd, { timeout: 10000 });
			console.log(`[aria-autopipe] codex mcp add stdout:`, out.stdout.trim());
			console.log(`[aria-autopipe] codex mcp add stderr:`, out.stderr.trim());
			addErr = '';
			break;
		} catch (err) {
			addErr = (err as { stderr?: string }).stderr ?? String(err);
			await new Promise(r => setTimeout(r, 120 + Math.floor(Math.random() * 400) * (attempt + 1)));
		}
	}
	if (addErr) {
		console.error('[aria-autopipe] codex mcp add failed:', addErr);
		return { ok: false, changed: false, message: `codex mcp add failed: ${addErr.trim()}` };
	}

	// Verify via `codex mcp list`. A successful add should be reflected
	// here; if not, surface the actual list so the user can see what
	// Codex thinks is registered.
	try {
		const listOut = await execAsync(`${q} mcp list`, { timeout: 10000 });
		console.log(`[aria-autopipe] codex mcp list:\n${listOut.stdout.trim()}`);
		if (!listOut.stdout.includes(name)) {
			return {
				ok: false,
				changed: true,
				message: `Registered with no error but "${name}" missing from \`codex mcp list\`. Output: ${listOut.stdout.trim().slice(0, 300)}`,
			};
		}
	} catch (err) {
		console.warn('[aria-autopipe] codex mcp list verification failed:', err);
	}

	return { ok: true, changed: true, message: `Registered ${name} -> ${url}` };
}

/** Remove Qoka's MCP registration from Codex during deactivate(). */
export async function unregisterFromCodex(): Promise<void> {
	const codex = await resolveCodexBinary();
	if (!codex) {
		return;
	}
	const q = quoteArg(codex);
	for (const name of [MCP_NAME, LEGACY_MCP_NAME]) {
		try {
			await execAsync(`${q} mcp remove ${name}`, { timeout: 10000 });
		} catch {
			// stale entries are best-effort
		}
	}
}

function quoteArg(s: string): string {
	if (/^[A-Za-z0-9_./:-]+$/.test(s)) {
		return s;
	}
	return `"${s.replace(/"/g, '\\"')}"`;
}
