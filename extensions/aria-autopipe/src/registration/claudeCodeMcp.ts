/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { exec } from 'child_process';
import { promisify } from 'util';
import { candidateClaudePaths } from '../detection/claudeCodeDetector';

const execAsync = promisify(exec);

// `autopipe` is the same name the standalone autopipe-app Tauri build
// registers under. Aria now replaces it — the user is expected to shut down
// autopipe-app and rely on Aria alone, so we adopt the original name so
// existing Claude Code conversations / saved prompts referring to
// "autopipe" tools continue to work without any user-side rename.
const MCP_NAME = 'autopipe';
// Older Aria builds registered as `aria-autopipe`. Remove that entry too
// when we start up so the user isn't left with a stale duplicate.
const LEGACY_MCP_NAME = 'aria-autopipe';

/**
 * Resolve which `claude` binary to drive. Tries the shell PATH first (cheap),
 * then probes the well-known install locations that the desktop launcher's
 * sparse PATH often misses. Returns `null` when no Claude CLI is reachable.
 */
async function resolveClaudeBinary(): Promise<string | null> {
	try {
		await execAsync('claude --version', { timeout: 5000 });
		return 'claude';
	} catch {
		// fall through
	}
	for (const candidate of candidateClaudePaths()) {
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
}

/**
 * (Re-)register Aria's MCP server with Claude Code so the CLI advertises
 * Autopipe's tools in every new conversation. Always removes the existing
 * `aria-autopipe` entry first — the port can change between Aria runs when
 * autopipe-app holds 3748, so re-running the same `claude mcp add` would
 * fail with "already exists". Removing first makes the operation idempotent.
 */
export async function registerWithClaudeCode(port: number): Promise<RegistrationResult> {
	console.log(`[aria-autopipe] registerWithClaudeCode(port=${port}) starting`);
	const claude = await resolveClaudeBinary();
	if (!claude) {
		console.error('[aria-autopipe] Claude CLI not found in PATH or candidate locations');
		return { ok: false, message: 'Claude CLI not found on PATH or known install locations.' };
	}
	console.log(`[aria-autopipe] Claude CLI resolved to: ${claude}`);

	const url = `http://127.0.0.1:${port}/sse`;
	const q = quoteArg(claude);

	// Best-effort removal across all three scopes. `claude mcp add`
	// defaults to "local" (per-project) — that's what tied the previous
	// registration to a single workspace and made autopipe invisible
	// everywhere else. We clear out any straggler entries in user/project
	// scope too so the next add lands clean.
	for (const name of [MCP_NAME, LEGACY_MCP_NAME]) {
		for (const scope of ['user', 'project', 'local']) {
			try {
				const out = await execAsync(`${q} mcp remove ${name} --scope ${scope}`, { timeout: 10000 });
				console.log(`[aria-autopipe] removed prior MCP entry "${name}" (--scope ${scope}):`, out.stdout.trim());
			} catch (err) {
				// "No MCP server found" is the expected outcome on a clean
				// machine; only worth a debug log.
				console.log(`[aria-autopipe] no prior MCP entry "${name}" --scope ${scope}:`, (err as Error).message);
			}
		}
	}

	// `--scope user` writes to the per-user config so autopipe is
	// reachable from every project Claude Code opens — not just the
	// directory Aria happened to launch from.
	const addCmd = `${q} mcp add --scope user ${MCP_NAME} ${quoteArg(url)} --transport sse`;
	console.log(`[aria-autopipe] running: ${addCmd}`);
	try {
		const out = await execAsync(addCmd, { timeout: 10000 });
		console.log(`[aria-autopipe] mcp add stdout:`, out.stdout.trim());
		console.log(`[aria-autopipe] mcp add stderr:`, out.stderr.trim());
	} catch (err) {
		const stderr = (err as { stderr?: string }).stderr ?? String(err);
		console.error(`[aria-autopipe] claude mcp add failed:`, stderr);
		return { ok: false, message: `claude mcp add failed: ${stderr.trim()}` };
	}

	// Verify by reading `claude mcp list`. A successful add command doesn't
	// always guarantee the entry made it into the user's config when scopes
	// (user/project/local) misalign, so we confirm explicitly and surface
	// what's actually there.
	try {
		const listOut = await execAsync(`${q} mcp list`, { timeout: 10000 });
		console.log(`[aria-autopipe] claude mcp list:\n${listOut.stdout.trim()}`);
		if (!listOut.stdout.includes(MCP_NAME)) {
			return {
				ok: false,
				message: `Registered with no error but "${MCP_NAME}" missing from \`claude mcp list\`. Output: ${listOut.stdout.trim().slice(0, 300)}`,
			};
		}
	} catch (err) {
		console.warn(`[aria-autopipe] claude mcp list verification failed:`, err);
	}

	return { ok: true, message: `Registered ${MCP_NAME} -> ${url}` };
}

/**
 * Remove Aria's MCP registration. Called from `deactivate()` so the user's
 * Claude Code state doesn't keep a stale entry pointing at a port the next
 * Aria session may not own.
 */
export async function unregisterFromClaudeCode(): Promise<void> {
	const claude = await resolveClaudeBinary();
	if (!claude) {
		return;
	}
	const q = quoteArg(claude);
	for (const name of [MCP_NAME, LEGACY_MCP_NAME]) {
		for (const scope of ['user', 'project', 'local']) {
			try {
				await execAsync(`${q} mcp remove ${name} --scope ${scope}`, { timeout: 10000 });
			} catch {
				// stale entries are best-effort
			}
		}
	}
}

function quoteArg(s: string): string {
	if (/^[A-Za-z0-9_./:-]+$/.test(s)) {
		return s;
	}
	// Wrap in double quotes and escape any embedded double quotes. Backslashes
	// don't need special handling for our use (URLs + binary paths).
	return `"${s.replace(/"/g, '\\"')}"`;
}
