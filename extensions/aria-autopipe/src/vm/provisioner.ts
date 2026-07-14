/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as https from 'https';
import * as path from 'path';

const execFileAsync = promisify(execFile);

/**
 * Downloads the assets the built-in VM needs — a PORTABLE QEMU build and the base
 * disk image — from GitHub Releases into Aria's app-data. This is what lets a
 * user with no admin rights run the VM: nothing is installed system-wide; qemu
 * runs in-place from the app folder.
 *
 * Assets are produced by the release CI and named by platform/arch:
 *   qemu-<darwin|win32|linux>-<arm64|x64>.tar.gz   (contains bin/qemu-system-*)
 *   aria-vm-<arm64|x64>.qcow2                       (prebuilt Ubuntu+docker image)
 *
 * Dev escape hatches: ARIA_QEMU_PATH / ARIA_AUTOPIPE_VM_IMAGE point at local files
 * and skip downloading; ARIA_VM_RELEASE_BASE overrides the asset host.
 */

const RELEASE_BASE = process.env.ARIA_VM_RELEASE_BASE
	|| 'https://github.com/khyeonm/aria-vscode/releases/download/vm-assets-v1';

export type ProgressFn = (message: string, pct?: number) => void;

export class Provisioner {
	constructor(private readonly dir: string) { }

	private plat(): string { return process.platform; }
	private arch(): string { return process.arch === 'arm64' ? 'arm64' : 'x64'; }
	private qemuArch(): string { return process.arch === 'arm64' ? 'aarch64' : 'x86_64'; }

	qemuDir(): string { return path.join(this.dir, 'qemu'); }

	/** Path to the qemu-system binary once extracted (or the dev override). */
	qemuBinPath(): string {
		if (process.env.ARIA_QEMU_PATH) { return process.env.ARIA_QEMU_PATH; }
		const exe = process.platform === 'win32' ? '.exe' : '';
		return path.join(this.qemuDir(), 'bin', `qemu-system-${this.qemuArch()}${exe}`);
	}

	imagePath(): string {
		return process.env.ARIA_AUTOPIPE_VM_IMAGE || path.join(this.dir, `base-${this.arch()}.qcow2`);
	}

	/** True if the qemu binary actually loads and runs (all dylibs resolve). A
	 *  broken bundle fails here instead of silently at VM-boot time. */
	private async qemuRuns(bin: string): Promise<boolean> {
		try {
			await execFileAsync(bin, ['--version'], { timeout: 15000 });
			return true;
		} catch {
			return false;
		}
	}

	/** Ensure the portable qemu is present AND actually runnable; download +
	 *  extract if missing or broken. */
	async ensureQemu(progress: ProgressFn): Promise<string> {
		const bin = this.qemuBinPath();
		if (process.env.ARIA_QEMU_PATH) {
			if (fs.existsSync(bin)) { return bin; }
			throw new Error(`ARIA_QEMU_PATH set but not found: ${process.env.ARIA_QEMU_PATH}`);
		}
		if (fs.existsSync(bin)) {
			// Re-validate the cached bundle: a `--version` that fails means an
			// unresolved dylib (e.g. a previously-cached build missing
			// libcapstone). Without this, a fixed vm-assets release never reaches
			// anyone who already downloaded the broken one — existsSync alone would
			// keep using it forever. Wipe and re-download when it can't even load.
			if (await this.qemuRuns(bin)) { return bin; }
			progress('Updating the local run environment (QEMU)…');
			try { fs.rmSync(this.qemuDir(), { recursive: true, force: true }); } catch { /* re-created below */ }
		}
		const asset = `qemu-${this.plat()}-${this.arch()}.tar.gz`;
		const tgz = path.join(this.dir, asset);
		progress('Downloading the local run environment (QEMU)…');
		await this.download(`${RELEASE_BASE}/${asset}`, tgz, (pct) => progress('Downloading QEMU…', pct));
		progress('Unpacking QEMU…');
		fs.mkdirSync(this.qemuDir(), { recursive: true });
		await execFileAsync('tar', ['-xzf', tgz, '-C', this.qemuDir()]);
		try { fs.rmSync(tgz); } catch { /* ignore */ }
		if (!fs.existsSync(bin)) {
			throw new Error('QEMU package did not contain the expected binary.');
		}
		if (process.platform !== 'win32') { try { fs.chmodSync(bin, 0o755); } catch { /* ignore */ } }
		return bin;
	}

	/** Ensure the base VM image is present; download if missing. */
	async ensureImage(progress: ProgressFn): Promise<string> {
		const img = this.imagePath();
		if (fs.existsSync(img)) { return img; }
		if (process.env.ARIA_AUTOPIPE_VM_IMAGE) {
			throw new Error(`ARIA_AUTOPIPE_VM_IMAGE set but not found: ${process.env.ARIA_AUTOPIPE_VM_IMAGE}`);
		}
		const asset = `aria-vm-${this.arch()}.qcow2`;
		progress('Downloading the run environment image…');
		await this.download(`${RELEASE_BASE}/${asset}`, img + '.part', (pct) => progress('Downloading VM image…', pct));
		fs.renameSync(img + '.part', img); // atomic: a half-download never looks complete
		return img;
	}

	/** HTTPS GET to a file with redirect handling (GitHub → object store) and a
	 *  byte-progress callback. Streams to disk. */
	private download(url: string, dest: string, onPct: (pct: number) => void, redirects = 0): Promise<void> {
		return new Promise((resolve, reject) => {
			if (redirects > 5) { reject(new Error('Too many redirects downloading ' + url)); return; }
			const req = https.get(url, { headers: { 'User-Agent': 'Aria' } }, (res) => {
				if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
					res.resume();
					this.download(res.headers.location, dest, onPct, redirects + 1).then(resolve, reject);
					return;
				}
				if (res.statusCode !== 200) {
					res.resume();
					reject(new Error(`Download failed (${res.statusCode}) for ${url}`));
					return;
				}
				const total = Number(res.headers['content-length'] || 0);
				let got = 0;
				const out = fs.createWriteStream(dest);
				res.on('data', (chunk) => {
					got += chunk.length;
					if (total) { onPct(Math.round((got / total) * 100)); }
				});
				res.pipe(out);
				out.on('finish', () => out.close(() => resolve()));
				out.on('error', (e) => { try { fs.rmSync(dest); } catch { /* ignore */ } reject(e); });
			});
			req.on('error', reject);
		});
	}
}
