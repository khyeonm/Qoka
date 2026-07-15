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

// Bumped whenever the published aria-vm-<arch>.qcow2 changes in a way that a
// cached copy must be replaced. v2 = docker baked in + disk resized to 20G.
// A cached image whose tag differs is deleted and re-downloaded (see
// ensureImage), and its overlay is discarded so it rebuilds against the new base.
const IMAGE_TAG = 'v2-docker';

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

	// --- vfkit (macOS Apple Virtualization.framework backend) ----------------

	vfkitDir(): string { return path.join(this.dir, 'vfkit'); }
	vfkitBinPath(): string { return process.env.ARIA_VFKIT_PATH || path.join(this.vfkitDir(), 'bin', 'vfkit'); }
	gvproxyBinPath(): string { return path.join(this.vfkitDir(), 'bin', 'gvproxy'); }

	/** Ensure the vfkit + gvproxy bundle is present; download + extract if missing.
	 *  macOS only — vfkit drives Apple's Virtualization.framework, which works on
	 *  every Apple Silicon generation (unlike qemu's HVF, broken on M4). */
	async ensureVfkit(progress: ProgressFn): Promise<{ vfkit: string; gvproxy: string }> {
		const vfkit = this.vfkitBinPath();
		const gvproxy = this.gvproxyBinPath();
		if (process.env.ARIA_VFKIT_PATH) {
			if (fs.existsSync(vfkit)) { return { vfkit, gvproxy }; }
			throw new Error(`ARIA_VFKIT_PATH set but not found: ${process.env.ARIA_VFKIT_PATH}`);
		}
		if (fs.existsSync(vfkit) && fs.existsSync(gvproxy)) { return { vfkit, gvproxy }; }
		const asset = 'vfkit-darwin.tar.gz';
		const tgz = path.join(this.dir, asset);
		progress('Downloading the Mac run environment (vfkit)…');
		await this.download(`${RELEASE_BASE}/${asset}`, tgz, (pct) => progress('Downloading vfkit…', pct));
		progress('Unpacking vfkit…');
		fs.mkdirSync(this.vfkitDir(), { recursive: true });
		await execFileAsync('tar', ['-xzf', tgz, '-C', this.vfkitDir()]);
		try { fs.rmSync(tgz); } catch { /* ignore */ }
		if (!fs.existsSync(vfkit) || !fs.existsSync(gvproxy)) {
			throw new Error('vfkit package did not contain the expected binaries.');
		}
		for (const b of [vfkit, gvproxy]) { try { fs.chmodSync(b, 0o755); } catch { /* ignore */ } }
		return { vfkit, gvproxy };
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

	/** Ensure the base VM image is present AND current; download if missing or
	 *  if the cached copy predates the current IMAGE_TAG (e.g. an old image
	 *  without docker baked in). */
	async ensureImage(progress: ProgressFn): Promise<string> {
		const img = this.imagePath();
		// Dev override: use the local file as-is, no tag/version handling.
		if (process.env.ARIA_AUTOPIPE_VM_IMAGE) {
			if (fs.existsSync(img)) { return img; }
			throw new Error(`ARIA_AUTOPIPE_VM_IMAGE set but not found: ${process.env.ARIA_AUTOPIPE_VM_IMAGE}`);
		}
		const tagFile = path.join(this.dir, 'image.tag');
		const currentTag = fs.existsSync(tagFile) ? fs.readFileSync(tagFile, 'utf8').trim() : '';
		if (fs.existsSync(img) && currentTag === IMAGE_TAG) { return img; }
		// Missing, or a stale generation: discard the old base AND its overlay
		// (the overlay's backing file / size no longer matches the new base, so
		// on Windows — where the overlay is persisted — it would fail to open).
		if (fs.existsSync(img)) {
			try { fs.rmSync(img); } catch { /* overwritten below */ }
		}
		// Discard derived per-boot disks so they rebuild against the new base:
		// the qemu overlay (Windows) and the vfkit raw conversion (macOS).
		try { fs.rmSync(path.join(this.dir, 'overlay.qcow2')); } catch { /* may not exist */ }
		try { fs.rmSync(path.join(this.dir, 'disk.raw')); } catch { /* may not exist */ }
		const asset = `aria-vm-${this.arch()}.qcow2`;
		progress('Downloading the run environment image…');
		await this.download(`${RELEASE_BASE}/${asset}`, img + '.part', (pct) => progress('Downloading VM image…', pct));
		fs.renameSync(img + '.part', img); // atomic: a half-download never looks complete
		try { fs.writeFileSync(tagFile, IMAGE_TAG); } catch { /* best-effort marker */ }
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
