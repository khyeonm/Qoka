/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Resolve which git binary to run for the loop's code version tree. This is vscode-free so the
// engine can import it. On Windows a GUI app rarely has git on PATH, so we prefer the bundled
// MinGit that aria-vcs ships and extracts once into the per-user Qoka data dir
// (%LOCALAPPDATA%\Qoka\mingit\cmd\git.exe); if that isn't there yet we fall back to a PATH `git`.
// On mac/Linux the loop just uses PATH git. Best-effort: a bad path only means the version tree
// stays empty (the engine's git calls are already wrapped in try/catch).

import * as fs from 'fs';
import * as path from 'path';

// Cache ONLY a positive bundled-MinGit hit. The 'git' fallback is re-checked every call, so a lookup
// that ran before aria-vcs extracted MinGit isn't stuck on PATH git for the rest of the session.
let cachedBundled: string | undefined;

export function resolveGitBinary(): string {
	if (cachedBundled) { return cachedBundled; }
	if (process.platform === 'win32') {
		const localAppData = process.env.LOCALAPPDATA;
		if (localAppData) {
			const bundled = path.join(localAppData, 'Qoka', 'mingit', 'cmd', 'git.exe');
			try { if (fs.existsSync(bundled)) { cachedBundled = bundled; return cachedBundled; } } catch { /* fall through */ }
		}
	}
	return 'git';
}
