/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { exec } from 'child_process';
import { promisify } from 'util';
import { candidateClaudePaths } from '../detection/claudeCodeDetector';

const execAsync = promisify(exec);

// Every Qoka server is `qoka-*`. This one used to be plain `autopipe`, which is
// ALSO what the standalone autopipe-app registers - sharing the name meant our
// http entry and its stdio entry landed in one config block, which Codex rejects
// outright ("url is not supported for stdio") and which broke every chat. The
// prefix keeps the two apps independent.
const MCP_NAME = 'qoka-autopipe';
// Names earlier builds registered under. Removed on startup so the user is not
// left with stale duplicates serving the same tools twice.
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
	/**
	 * True when this run actually (re)wrote the registration; false when it was
	 * skipped because the client already pointed at our live port.
	 */
	changed: boolean;
}

/**
 * Read the port the client currently has registered for `autopipe`, or null
 * when it isn't registered / can't be read. Lets us skip a redundant
 * remove+add when the existing entry already points at our live server.
 */
async function readClaudeRegisteredPort(claude: string, name: string): Promise<number | null> {
	try {
		const out = await execAsync(`${quoteArg(claude)} mcp get ${name}`, { timeout: 10000 });
		const m = out.stdout.match(/127\.0\.0\.1:(\d+)/);
		return m ? parseInt(m[1], 10) : null;
	} catch {
		// Not registered, or this CLI lacks `mcp get` - treat as unknown so the
		// caller registers (never skip when we're unsure).
		return null;
	}
}

/**
 * (Re-)register Qoka's MCP server with Claude Code so the CLI advertises
 * Autopipe's tools in every new conversation. Always removes the existing
 * `aria-autopipe` entry first - the port can change between Qoka runs when
 * autopipe-app holds 3748, so re-running the same `claude mcp add` would
 * fail with "already exists". Removing first makes the operation idempotent.
 */
export async function registerWithClaudeCode(port: number, name: string = MCP_NAME): Promise<RegistrationResult> {
	console.log(`[aria-autopipe] registerWithClaudeCode(name=${name}, port=${port}) starting`);
	const claude = await resolveClaudeBinary();
	if (!claude) {
		console.error('[aria-autopipe] Claude CLI not found in PATH or candidate locations');
		return { ok: false, changed: false, message: 'Claude CLI not found on PATH or known install locations.' };
	}
	console.log(`[aria-autopipe] Claude CLI resolved to: ${claude}`);

	const url = `http://127.0.0.1:${port}/sse`;
	const q = quoteArg(claude);

	// Skip the (expensive) remove+add when the client already points at our
	// live port. The port is the discriminator: an entry on a *different* port
	// is stale (a previous run, or the standalone autopipe-app holding 3748),
	// and one on *this* port already targets the server we just started.
	const existingPort = await readClaudeRegisteredPort(claude, name);
	if (existingPort === port) {
		console.log(`[aria-autopipe] Claude Code already registered "${name}" on port ${port}; skipping re-registration`);
		return { ok: true, changed: false, message: `Already registered -> ${url}` };
	}

	// Best-effort removal across all three scopes. `claude mcp add`
	// defaults to "local" (per-project) - that's what tied the previous
	// registration to a single workspace and made autopipe invisible
	// everywhere else. We clear out any straggler entries in user/project
	// scope too so the next add lands clean.
	// Remove the legacy `aria-autopipe` entry only for the autopipe server; a
	// second server (e.g. qoka-run) clears just its own name.
	const rmNames = name === MCP_NAME ? [MCP_NAME, LEGACY_MCP_NAME] : [name];
	for (const rmName of rmNames) {
		for (const scope of ['user', 'project', 'local']) {
			try {
				const out = await execAsync(`${q} mcp remove ${rmName} --scope ${scope}`, { timeout: 10000 });
				console.log(`[aria-autopipe] removed prior MCP entry "${rmName}" (--scope ${scope}):`, out.stdout.trim());
			} catch (err) {
				// "No MCP server found" is the expected outcome on a clean
				// machine; only worth a debug log.
				console.log(`[aria-autopipe] no prior MCP entry "${rmName}" --scope ${scope}:`, (err as Error).message);
			}
		}
	}

	// `--scope user` writes to the per-user config so the server is
	// reachable from every project Claude Code opens - not just the
	// directory Qoka happened to launch from.
	const addCmd = `${q} mcp add --scope user ${name} ${quoteArg(url)} --transport sse`;
	console.log(`[aria-autopipe] running: ${addCmd}`);
	try {
		const out = await execAsync(addCmd, { timeout: 10000 });
		console.log(`[aria-autopipe] mcp add stdout:`, out.stdout.trim());
		console.log(`[aria-autopipe] mcp add stderr:`, out.stderr.trim());
	} catch (err) {
		const stderr = (err as { stderr?: string }).stderr ?? String(err);
		console.error(`[aria-autopipe] claude mcp add failed:`, stderr);
		return { ok: false, changed: false, message: `claude mcp add failed: ${stderr.trim()}` };
	}

	// Verify by reading `claude mcp list`. A successful add command doesn't
	// always guarantee the entry made it into the user's config when scopes
	// (user/project/local) misalign, so we confirm explicitly and surface
	// what's actually there.
	try {
		const listOut = await execAsync(`${q} mcp list`, { timeout: 10000 });
		console.log(`[aria-autopipe] claude mcp list:\n${listOut.stdout.trim()}`);
		if (!listOut.stdout.includes(name)) {
			return {
				ok: false,
				changed: true,
				message: `Registered with no error but "${name}" missing from \`claude mcp list\`. Output: ${listOut.stdout.trim().slice(0, 300)}`,
			};
		}
	} catch (err) {
		console.warn(`[aria-autopipe] claude mcp list verification failed:`, err);
	}

	return { ok: true, changed: true, message: `Registered ${name} -> ${url}` };
}

/**
 * Remove Qoka's MCP registration. Called from `deactivate()` so the user's
 * Claude Code state doesn't keep a stale entry pointing at a port the next
 * Qoka session may not own.
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
