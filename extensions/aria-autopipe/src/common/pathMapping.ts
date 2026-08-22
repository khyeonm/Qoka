/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { services } from './services';
import { workspaceFolderPath } from './workspaceSync';

/**
 * Local-path -> run-environment-path mapping for notebook authoring.
 *
 * A notebook's cells run in the ACTIVE run environment (WSL / vfkit / SSH), which
 * has its OWN filesystem, so a LOCAL absolute path the AI (or user) writes into a
 * cell - e.g. Windows `C:\Users\me\project\data\x.csv` or Mac
 * `/Users/me/project/data/x.csv` - does not exist there and the cell errors with
 * FileNotFound. For the built-in local run environment the open project is MOUNTED
 * into the VM, so the fix is deterministic: rewrite the known local path to its
 * mounted equivalent.
 *
 *   - WSL (Windows built-in): the whole Windows drive is visible under /mnt/<drive>,
 *     so ANY `C:\…` / `D:/…` absolute path maps to `/mnt/c/…` etc. (windowsToWsl).
 *   - vfkit (Mac built-in): only the OPEN PROJECT is shared, mounted at /mnt/qoka,
 *     so a path under the project root maps by prefix; paths outside the project are
 *     not shared into the VM and are left as-is (they are unreachable anyway).
 *   - SSH: the notebook runs ON the remote server, which has no mount of the local
 *     disk, so NOTHING is rewritten - the user must reference data that already
 *     lives on that server. Callers surface that as a note.
 *
 * The rewrite is intentionally conservative: it only replaces an exact drive-letter
 * prefix (WSL) or the exact open-project root prefix (vfkit), so it can never corrupt
 * unrelated code.
 */

/** Mount point of the Mac vfkit virtio-fs share (see vmManager VFKIT_SHARE_MOUNT). */
const VFKIT_MOUNT = '/mnt/qoka';

export type RunPathMappingKind = 'wsl' | 'vfkit' | 'ssh' | 'none';

export interface RunPathMapping {
	/** How cell paths should be treated for the currently-active run target. */
	kind: RunPathMappingKind;
	/** The open project's LOCAL absolute path (host form), when a folder is open. */
	hostRoot?: string;
	/** Where that project is reachable inside the run env (vfkit: /mnt/qoka). */
	mountRoot?: string;
}

/**
 * Determine the active run target's path mapping WITHOUT booting the VM (reads
 * config only, so create_notebook stays cheap). `isLocalVmActive` picks WSL vs
 * vfkit by platform; anything else is a user SSH profile (or nothing selected).
 */
export function getRunPathMapping(): RunPathMapping {
	const { config } = services();
	const hostRoot = (workspaceFolderPath() || '').replace(/[\\/]+$/, '') || undefined;
	if (config.isLocalVmActive()) {
		if (process.platform === 'win32') {
			return { kind: 'wsl', hostRoot };
		}
		if (process.platform === 'darwin') {
			return { kind: 'vfkit', hostRoot, mountRoot: VFKIT_MOUNT };
		}
		// A Linux built-in VM has no reliable host-disk mount, so don't rewrite.
		return { kind: 'none', hostRoot };
	}
	const profile = config.activeProfile();
	return { kind: profile ? 'ssh' : 'none', hostRoot };
}

/** Escape a string for use as a literal inside a RegExp. */
function escapeRegExp(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Convert a matched Windows absolute path (`C:\a\b` / `C:/a/b`) to WSL form
 *  (`/mnt/c/a/b`), collapsing separators. The match may contain escaped
 *  backslashes (`C:\\a\\b`) when it came from a source string literal. */
function winToWsl(match: string): string {
	const drive = match[0].toLowerCase();
	let rest = match.slice(2).replace(/\\+/g, '/').replace(/\/+/g, '/');
	if (rest.startsWith('/')) { rest = rest.slice(1); }
	return rest ? `/mnt/${drive}/${rest}` : `/mnt/${drive}`;
}

/**
 * Rewrite LOCAL absolute paths in a cell's source to their run-environment
 * equivalent, per the active target. Returns the source unchanged for SSH/none
 * (and for markdown, which the caller decides). Safe to call on any source.
 */
export function rewriteCellPaths(source: string, m: RunPathMapping): string {
	if (!source) { return source; }
	if (m.kind === 'wsl') {
		// Any Windows drive-letter absolute path -> /mnt/<drive>/…. Stops at
		// whitespace or a quote/paren so it only grabs the path token itself. The
		// lookbehind keeps it from matching a letter mid-word (e.g. the "s:" in
		// "https://…"), which would otherwise corrupt URLs.
		return source.replace(/(?<![A-Za-z])[A-Za-z]:[\\/][^\s"'`)]*/g, winToWsl);
	}
	if (m.kind === 'vfkit' && m.hostRoot && m.mountRoot) {
		// Only the open project is shared, mounted at /mnt/qoka. Replace the exact
		// project-root prefix when it is followed by a path boundary (so a longer
		// sibling path like /Users/me/project-2 is never mangled).
		const re = new RegExp(escapeRegExp(m.hostRoot) + `(?=[/"'\`\\s)\\]:,]|$)`, 'g');
		return source.replace(re, m.mountRoot);
	}
	return source;
}

/**
 * Map ONE local absolute path (the user's own disk) to where it is reachable
 * inside the active LOCAL run environment, for staging pipeline input data.
 *   - WSL: any drive path -> /mnt/<drive>/… (the whole disk is mounted).
 *   - vfkit: only the OPEN PROJECT is mounted at /mnt/qoka, so a path INSIDE the
 *     project maps to /mnt/qoka/…; anything outside returns an error (the user
 *     must move the file into the project first - we never silently copy).
 * `{ path }` on success, `{ error }` when the file is unreachable. SSH/none is a
 * caller error (server paths are used verbatim there), so it echoes the input.
 */
export function localToRunEnvPath(localPath: string): { path: string } | { error: string } {
	const m = getRunPathMapping();
	if (m.kind === 'wsl') {
		const match = /^[A-Za-z]:[\\/].*$/.test(localPath);
		return { path: match ? winToWsl(localPath) : localPath };
	}
	if (m.kind === 'vfkit' && m.hostRoot && m.mountRoot) {
		const norm = localPath.replace(/\\/g, '/').replace(/\/+$/, '');
		const root = m.hostRoot.replace(/\\/g, '/').replace(/\/+$/, '');
		if (norm === root || norm.startsWith(root + '/')) {
			return { path: m.mountRoot + norm.slice(root.length) };
		}
		return { error: 'On the Mac run environment only the open project folder is mounted. Move this file into the project (e.g. into data/) and pick it again.' };
	}
	return { path: localPath };
}

/**
 * A short, model-facing note about how the active target treats data paths, to
 * append to a create_notebook / edit_notebook result so the assistant relays it.
 * `undefined` when there is nothing worth saying.
 */
export function pathMappingNote(m: RunPathMapping): string | undefined {
	if (m.kind === 'ssh') {
		return 'NOTE: an SSH server is the active run connection, so this notebook runs ON that server. It can only read data that already exists on the SSH server - a LOCAL path (the user\'s own computer) will not be found. Tell the user to point cells at data that lives on the SSH server (or to switch to the built-in local run environment if they want to use local data).';
	}
	if (m.kind === 'wsl') {
		return 'Cell paths pointing at the user\'s Windows disk (e.g. C:\\Users\\…) are automatically rewritten to their WSL form (/mnt/c/…) so they resolve in the run environment.';
	}
	if (m.kind === 'vfkit' && m.hostRoot) {
		return `The open project is mounted into the local VM at ${VFKIT_MOUNT}, and paths under the project root are rewritten to it automatically. Prefer relative paths (data/…) so cells stay portable.`;
	}
	return undefined;
}
