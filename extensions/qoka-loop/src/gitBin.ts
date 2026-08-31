/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Resolve which git binary to run for the loop's code version tree. On Windows a GUI app rarely has
// git on PATH, so the source of truth is aria-vcs (it ships and extracts a bundled MinGit): warmGitBinary()
// asks it via the aria.vcs.resolveGitPath command and caches the answer. The sync resolveGitBinary()
// returns that cached value for the sync call sites (the webview version list + the content provider);
// before the cache is warm - or if aria-vcs is absent - it falls back to the known MinGit install path,
// then to a PATH `git`. Best-effort: a bad path only means the version tree stays empty (all git calls
// are wrapped in try/catch).

import * as fs from 'fs';
import * as path from 'path';

/** Set once by warmGitBinary() from aria-vcs; the authoritative git path for this session. */
let warmed: string | undefined;

/** Best-effort synchronous guess when the warm cache isn't set yet. */
function guess(): string {
	if (process.platform === 'win32') {
		const localAppData = process.env.LOCALAPPDATA;
		if (localAppData) {
			const bundled = path.join(localAppData, 'Qoka', 'mingit', 'cmd', 'git.exe');
			try { if (fs.existsSync(bundled)) { return bundled; } } catch { /* fall through */ }
		}
	}
	return 'git';
}

/** Ask aria-vcs to resolve (and, on Windows, extract) git, and cache the path. Call once at activation
 *  and again right before a loop starts so the engine commits with a real git. Falls back to guess(). */
export async function warmGitBinary(vscodeCommands: { executeCommand: <T>(command: string, ...rest: unknown[]) => Thenable<T> }): Promise<string> {
	try {
		const p = await vscodeCommands.executeCommand<string | undefined>('aria.vcs.resolveGitPath');
		warmed = (typeof p === 'string' && p) ? p : guess();
	} catch {
		warmed = guess();
	}
	return warmed;
}

/** The git binary to run. Warm cache if set, else a best-effort guess (never throws). */
export function resolveGitBinary(): string {
	return warmed || guess();
}

/** Pre-command args that make a git call robust: `-c safe.directory=*` disarms the Windows
 *  "dubious ownership" refusal on a freshly created nested repo. Put BEFORE `-C`/the subcommand. */
export const GIT_SAFE_ARGS = ['-c', 'safe.directory=*'];

/** A clean git environment: drop inherited GIT_DIR / GIT_WORK_TREE so `-C <dir>` always targets the
 *  loop's own nested repo, not the workspace repo aria-vcs manages. */
export function gitEnv(): NodeJS.ProcessEnv {
	const e = { ...process.env };
	delete e.GIT_DIR; delete e.GIT_WORK_TREE; delete e.GIT_INDEX_FILE; delete e.GIT_COMMON_DIR; delete e.GIT_OBJECT_DIRECTORY;
	return e;
}
