/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Make a `node`/`npm` available for Aria's CLI installs on machines that don't
 * ship them (the common case for a non-developer on Windows). The Codex CLI is
 * an npm package, so without Node it can neither be installed nor run.
 *
 * We never require admin/sudo: a portable Node is downloaded from nodejs.org into
 * ~/.aria/node (the same dir headlessCli probes) and extracted in place. If the
 * machine already has a usable Node, we do nothing and let the system one win.
 *
 * The download host can be overridden with ARIA_NODE_DIST_BASE (tests/mirrors).
 */

import { spawn } from 'child_process';
import * as fs from 'fs';
import * as https from 'https';
import * as os from 'os';
import * as path from 'path';
import { ARIA_NODE_DIR, ariaNodeBinDir } from './headlessCli';
import { log } from './logger';

const isWin = process.platform === 'win32';

/** Portable Node version to fetch. Pinned; bump deliberately. */
const NODE_VERSION = '22.14.0';
const DIST_BASE = process.env.ARIA_NODE_DIST_BASE || 'https://nodejs.org/dist';

/** Node's platform/arch slugs for the tarball name. */
function nodePlatform(): string {
	switch (process.platform) {
		case 'darwin': return 'darwin';
		case 'win32': return 'win';
		default: return 'linux';
	}
}
function nodeArch(): string {
	switch (process.arch) {
		case 'arm64': return 'arm64';
		case 'x64': return 'x64';
		default: return 'x64';
	}
}

/** True when a `node` (and `npm`) already resolves — system install or a Node
 *  Aria provisioned earlier. */
function hasUsableNode(): boolean {
	if (ariaNodeBinDir()) {
		return true;
	}
	// Scan PATH for a real node executable (with Windows extensions).
	const names = isWin ? ['node.exe', 'node.cmd', 'node'] : ['node'];
	for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
		if (!dir) {
			continue;
		}
		for (const name of names) {
			try {
				if (fs.existsSync(path.join(dir, name))) {
					return true;
				}
			} catch {
				// keep looking
			}
		}
	}
	return false;
}

function download(url: string, dest: string, redirects = 0): Promise<void> {
	return new Promise((resolve, reject) => {
		if (redirects > 5) {
			reject(new Error(`Too many redirects for ${url}`));
			return;
		}
		const req = https.get(url, res => {
			const status = res.statusCode ?? 0;
			if (status >= 300 && status < 400 && res.headers.location) {
				res.resume();
				const next = new URL(res.headers.location, url).toString();
				download(next, dest, redirects + 1).then(resolve, reject);
				return;
			}
			if (status !== 200) {
				res.resume();
				reject(new Error(`GET ${url} → HTTP ${status}`));
				return;
			}
			const out = fs.createWriteStream(dest);
			res.pipe(out);
			out.on('finish', () => out.close(err => (err ? reject(err) : resolve())));
			out.on('error', reject);
		});
		req.on('error', reject);
	});
}

/** Run a command, resolving on exit 0 and rejecting otherwise. */
function run(cmd: string, args: string[], cwd: string): Promise<void> {
	return new Promise((resolve, reject) => {
		const child = spawn(cmd, args, { cwd, stdio: 'ignore' });
		child.on('error', reject);
		child.on('close', code => (code === 0 ? resolve() : reject(new Error(`${cmd} exited with ${code}`))));
	});
}

/** Extract a downloaded Node archive (.zip on Windows, .tar.xz elsewhere) so the
 *  binaries end up directly under ARIA_NODE_DIR. */
async function extract(archive: string, folder: string, into: string): Promise<void> {
	fs.mkdirSync(into, { recursive: true });
	if (isWin) {
		// bsdtar (tar.exe) ships on Windows 10+ and extracts .zip.
		await run('tar', ['-xf', archive, '-C', into], into);
	} else {
		await run('tar', ['-xJf', archive, '-C', into], into);
	}
	// Archives contain a single top-level `<folder>/` dir; hoist its contents to
	// ARIA_NODE_DIR so bin/ (or the exe root on Windows) sits where we expect.
	const top = path.join(into, folder);
	for (const entry of fs.readdirSync(top)) {
		fs.renameSync(path.join(top, entry), path.join(ARIA_NODE_DIR, entry));
	}
	fs.rmSync(top, { recursive: true, force: true });
}

/**
 * Guarantee a `node`/`npm` is available, returning the directory that must be on
 * PATH to use it (empty string when the system Node is used). Idempotent: once a
 * portable Node exists under ~/.aria/node it is reused.
 */
export async function ensureNode(): Promise<string> {
	if (hasUsableNode()) {
		return ariaNodeBinDir() ?? '';
	}

	const plat = nodePlatform();
	const arch = nodeArch();
	const folder = `node-v${NODE_VERSION}-${plat}-${arch}`;
	const ext = isWin ? 'zip' : 'tar.xz';
	const url = `${DIST_BASE}/v${NODE_VERSION}/${folder}.${ext}`;

	log(`nodeBootstrap: no system Node — downloading portable Node from ${url}`);
	fs.mkdirSync(ARIA_NODE_DIR, { recursive: true });
	const tmp = path.join(os.tmpdir(), `${folder}.${ext}`);
	await download(url, tmp);
	await extract(tmp, folder, path.join(ARIA_NODE_DIR, '.unpack'));
	fs.rmSync(tmp, { force: true });
	fs.rmSync(path.join(ARIA_NODE_DIR, '.unpack'), { recursive: true, force: true });

	const bin = ariaNodeBinDir();
	if (!bin) {
		throw new Error('nodeBootstrap: extraction finished but node bin dir is missing');
	}
	log(`nodeBootstrap: portable Node ready at ${bin}`);
	return bin;
}
