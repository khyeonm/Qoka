/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { exec } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';

const execAsync = promisify(exec);

/**
 * Detect and (if needed) install `uv` — the Python package manager every
 * science skill we ship depends on. uv handles per-script virtualenvs and
 * dependency resolution transparently, so without it `uv run script.py`
 * would fail with ImportError and the user would have no recourse.
 *
 * Detection is conservative: PATH first, then a handful of well-known
 * install locations the Aria launcher's sparse PATH may miss. Install is
 * the official `astral.sh` shell installer — same script the upstream uv
 * docs point at.
 */

const CANDIDATE_PATHS = [
	'/usr/local/bin/uv',
	'/opt/homebrew/bin/uv',
	path.join(os.homedir(), '.local/bin/uv'),
	path.join(os.homedir(), '.cargo/bin/uv'),
	path.join(os.homedir(), 'bin/uv'),
];

/** Quickly check whether `uv` resolves on the current PATH. */
async function tryPath(): Promise<string | null> {
	try {
		const { stdout } = await execAsync('uv --version', { timeout: 3000 });
		if (stdout.includes('uv')) {
			return 'uv';
		}
	} catch {
		// Fall through and try the candidate dirs.
	}
	return null;
}

/** Probe well-known install locations for a usable `uv` binary. */
async function tryCandidates(): Promise<string | null> {
	for (const p of CANDIDATE_PATHS) {
		if (!fs.existsSync(p)) {
			continue;
		}
		try {
			const { stdout } = await execAsync(`"${p}" --version`, { timeout: 3000 });
			if (stdout.includes('uv')) {
				return p;
			}
		} catch {
			// try next
		}
	}
	return null;
}

/**
 * Return the path to a usable `uv` binary, or null if uv is missing. The
 * Skills tab uses this to render the "uv installed" / "uv not installed"
 * badge in the environment section; the first-run wizard uses it to
 * decide whether to run the installer.
 */
export async function detectUv(): Promise<string | null> {
	const onPath = await tryPath();
	if (onPath) {
		return onPath;
	}
	return tryCandidates();
}

/**
 * Run the official uv installer script. This downloads a small bootstrap
 * shell script from astral.sh and pipes it into `sh`. The installer
 * places `uv` at ~/.local/bin/uv by default, which is one of the paths
 * we already probe.
 *
 * The installer is interactive only when stdin is a TTY; we feed an empty
 * stdin so it runs unattended. Errors bubble up to the caller; the UI is
 * responsible for surfacing them.
 */
export async function installUv(): Promise<string> {
	const cmd = 'curl -LsSf https://astral.sh/uv/install.sh | sh';
	await execAsync(cmd, { timeout: 120000 });
	// Re-detect to confirm the install landed somewhere we can find.
	const found = await detectUv();
	if (!found) {
		throw new Error(
			'uv installer ran without an error but the binary could not be found on PATH. '
			+ 'Restart your shell or open a new terminal and try again.',
		);
	}
	return found;
}

/**
 * Convenience for the first-run wizard: detect uv, install if missing,
 * return the resolved path either way. The wizard surfaces the boolean
 * "did we have to install?" so the progress UI can show "uv installed" vs
 * "uv ready" depending on what happened.
 */
export async function ensureUv(): Promise<{ path: string; justInstalled: boolean }> {
	const found = await detectUv();
	if (found) {
		return { path: found, justInstalled: false };
	}
	const installed = await installUv();
	return { path: installed, justInstalled: true };
}
