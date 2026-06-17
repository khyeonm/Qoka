/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as https from 'https';
import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

/** Pinned pandoc version (citeproc is built in). Bump this one constant to upgrade. */
export const PANDOC_VERSION = '3.10';

export interface EnsureOpts {
	/** Extension dir — checked for a bundled binary (<root>/bin/pandoc). */
	resourceRoot?: string;
	/** Writable cache dir (extension globalStorage) for the downloaded binary. */
	cacheDir: string;
	onStatus?: (message: string) => void;
}

/**
 * Resolve a usable pandoc binary, downloading it once if necessary. Resolution
 * order (fast → fallback): ARIA_PANDOC env, bundled <root>/bin, prior download
 * cache, pandoc on PATH, then a one-time download of the pinned version into
 * the cache dir. So the user never has to install or configure pandoc.
 */
export async function ensurePandoc(opts: EnsureOpts): Promise<string> {
	const log = opts.onStatus ?? (() => { });
	const binName = process.platform === 'win32' ? 'pandoc.exe' : 'pandoc';

	const env = process.env.ARIA_PANDOC;
	if (env && fs.existsSync(env)) { return env; }

	if (opts.resourceRoot) {
		const bundled = path.join(opts.resourceRoot, 'bin', binName);
		if (fs.existsSync(bundled)) { return bundled; }
	}

	const cacheVersionDir = path.join(opts.cacheDir, `pandoc-${PANDOC_VERSION}`);
	const cached = findFile(cacheVersionDir, binName);
	if (cached) { return cached; }

	if (await onPath(binName)) { return binName; }

	return await downloadPandoc(cacheVersionDir, binName, log);
}

async function onPath(cmd: string): Promise<boolean> {
	try {
		await execFileAsync(cmd, ['--version'], { timeout: 5000 });
		return true;
	} catch {
		return false;
	}
}

/** Breadth-first search for a file by name under `dir` (downloaded archives nest the binary). */
function findFile(dir: string, name: string): string | undefined {
	if (!fs.existsSync(dir)) { return undefined; }
	const stack = [dir];
	let guard = 0;
	while (stack.length && guard++ < 10000) {
		const d = stack.pop()!;
		let entries: fs.Dirent[] = [];
		try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
		for (const e of entries) {
			const full = path.join(d, e.name);
			if (e.isDirectory()) { stack.push(full); }
			else if (e.name === name) { return full; }
		}
	}
	return undefined;
}

function assetUrl(): string | undefined {
	const v = PANDOC_VERSION;
	const base = `https://github.com/jgm/pandoc/releases/download/${v}`;
	const arch = process.arch;
	switch (process.platform) {
		case 'linux':
			return `${base}/pandoc-${v}-linux-${arch === 'arm64' ? 'arm64' : 'amd64'}.tar.gz`;
		case 'darwin':
			return `${base}/pandoc-${v}-${arch === 'arm64' ? 'arm64' : 'x86_64'}-macOS.zip`;
		case 'win32':
			return `${base}/pandoc-${v}-windows-x86_64.zip`;
		default:
			return undefined;
	}
}

async function downloadPandoc(destDir: string, binName: string, log: (m: string) => void): Promise<string> {
	const url = assetUrl();
	if (!url) {
		throw new Error(`No prebuilt pandoc for ${process.platform}/${process.arch}. Install pandoc or set ARIA_PANDOC.`);
	}
	fs.mkdirSync(destDir, { recursive: true });
	const archive = path.join(destDir, path.basename(url));

	log(`Downloading pandoc ${PANDOC_VERSION} (one-time)…`);
	await httpDownload(url, archive);

	log('Extracting pandoc…');
	// `tar -xf` auto-detects gzip on Linux (GNU tar); bsdtar on macOS/Windows
	// also extracts .zip, so one command covers all platforms.
	await execFileAsync('tar', ['-xf', archive, '-C', destDir], { timeout: 180000 });

	const bin = findFile(destDir, binName);
	if (!bin) { throw new Error('pandoc binary not found after extraction.'); }
	if (process.platform !== 'win32') {
		try { fs.chmodSync(bin, 0o755); } catch { /* best-effort */ }
	}
	try { fs.unlinkSync(archive); } catch { /* keep going */ }
	log('pandoc ready.');
	return bin;
}

function httpDownload(url: string, dest: string, redirects = 0): Promise<void> {
	return new Promise((resolve, reject) => {
		if (redirects > 5) { return reject(new Error('too many redirects')); }
		const file = fs.createWriteStream(dest);
		https.get(url, res => {
			const status = res.statusCode ?? 0;
			if (status >= 300 && status < 400 && res.headers.location) {
				res.resume();
				file.close();
				fs.unlink(dest, () => { });
				const next = new URL(res.headers.location, url).toString();
				resolve(httpDownload(next, dest, redirects + 1));
				return;
			}
			if (status !== 200) {
				res.resume();
				file.close();
				fs.unlink(dest, () => { });
				reject(new Error(`HTTP ${status} downloading ${url}`));
				return;
			}
			res.pipe(file);
			file.on('finish', () => file.close(() => resolve()));
		}).on('error', err => {
			file.close();
			fs.unlink(dest, () => { });
			reject(err);
		});
	});
}
