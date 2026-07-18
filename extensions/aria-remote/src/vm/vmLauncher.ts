/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { spawn, ChildProcess, execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as net from 'net';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { Client } from 'ssh2';
import { Provisioner, ProgressFn } from './provisioner';
import { buildFatSeedImage } from './fatSeed';

const execFileAsync = promisify(execFile);

/**
 * Boots Aria's built-in VM on the HOST (ui) side and returns its SSH endpoint,
 * so the aria-remote resolver can launch the baked-in aria-reh server inside it.
 *
 * This is an adaptation of autopipe's VMManager with three deliberate changes:
 *   1. NO ConfigService dependency — it returns a BootedVm instead of pushing an
 *      endpoint into config. aria-remote owns the VM independently.
 *   2. NO 9p/virtfs host share — under the remote model the host project folder
 *      is shared via sshfs (a separate step), not 9p. So the qemu args and the
 *      cloud-init seed drop the 9p mount entirely.
 *   3. Guest home layout is /home/aria; the sshfs mount point (/home/aria/project)
 *      is created by the file-share wiring, not here.
 *
 * The boot mechanics (Windows QEMU+WHPX / macOS vfkit+gvproxy / Linux QEMU+KVM,
 * TCG fallback, cloud-init FAT seed) are preserved verbatim from VMManager.
 */

const GUEST_USER = 'aria';
const GUEST_HOME = `/home/${GUEST_USER}`;
const READY_TIMEOUT_MS = 360_000;

export interface BootedVm {
	host: string;
	port: number;
	username: string;
	privateKeyPath: string;
	stop(): Promise<void>;
}

interface VmSpec { cpus: number; memoryMB: number; diskGB: number; }

export class VmLauncher {
	private proc: ChildProcess | undefined;
	private gvproxyProc: ChildProcess | undefined;
	private readonly provisioner: Provisioner;

	constructor(private readonly dir: string) {
		fs.mkdirSync(this.dir, { recursive: true });
		this.provisioner = new Provisioner(this.dir);
	}

	/** Provision + boot; resolves once SSH is reachable. */
	async boot(progress: ProgressFn, log: (line: string) => void): Promise<BootedVm> {
		// Apple Silicon → vfkit (qemu's HVF asserts on M4). Everything else → qemu.
		if (process.platform === 'darwin' && process.arch === 'arm64') {
			return this.startVfkit(progress, log);
		}
		return this.startQemu(progress, log);
	}

	async stop(): Promise<void> {
		const procs = [this.proc, this.gvproxyProc].filter((p): p is ChildProcess => !!p);
		this.proc = undefined;
		this.gvproxyProc = undefined;
		await Promise.all(procs.map(p => this.killAndWait(p)));
	}

	// --- QEMU (Windows / Linux / Intel Mac) ---------------------------------

	private async startQemu(progress: ProgressFn, log: (line: string) => void): Promise<BootedVm> {
		const qemu = await this.provisioner.ensureQemu(progress);
		const image = await this.provisioner.ensureImage(progress);

		const key = await this.ensureKey();
		const port = await this.freePort();
		const overlay = path.join(this.dir, 'overlay.qcow2');
		const seed = await this.buildSeed(key + '.pub');
		const qimg = this.qemuImg(qemu);
		const spec = this.spec();

		// Windows: persist the overlay across boots (no host share, guest data lives
		// in it). Mac/Linux: fresh overlay each boot (base stays pristine).
		const createArgs = ['create', '-f', 'qcow2', '-F', 'qcow2', '-b', image, overlay, `${spec.diskGB}G`];
		if (process.platform === 'win32') {
			if (!fs.existsSync(overlay)) { await execFileAsync(qimg, createArgs, { windowsHide: true }); }
		} else {
			if (fs.existsSync(overlay)) { fs.rmSync(overlay); }
			await execFileAsync(qimg, createArgs, { windowsHide: true });
		}

		const primary = this.accel();
		const accels = primary === 'tcg' ? ['tcg'] : [primary, 'tcg'];
		let lastErr: Error | undefined;
		for (let i = 0; i < accels.length; i++) {
			const args = this.buildQemuArgs(accels[i], spec, qemu, overlay, seed, port);
			const errLog = fs.openSync(path.join(this.dir, 'qemu-stderr.log'), 'w');
			const proc = spawn(qemu, args, { stdio: ['ignore', 'ignore', errLog], windowsHide: true });
			this.proc = proc;
			proc.on('exit', () => { try { fs.closeSync(errLog); } catch { /* already closed */ } });
			try {
				await this.waitForSsh('127.0.0.1', port, key);
				log(`[aria-remote] VM ready (accel=${accels[i]}) on 127.0.0.1:${port}`);
				return this.bootedVm('127.0.0.1', port, key);
			} catch (err) {
				lastErr = err instanceof Error ? err : new Error(String(err));
				try { this.proc?.kill('SIGKILL'); } catch { /* ignore */ }
				this.proc = undefined;
				if (i < accels.length - 1) {
					progress('Hardware acceleration unavailable - retrying with software emulation (slower)…');
				}
			}
		}
		throw lastErr ?? new Error('The VM failed to start.');
	}

	private buildQemuArgs(accel: string, spec: VmSpec, qemu: string, overlay: string, seed: string, port: number): string[] {
		return [
			'-name', 'aria-vm', ...this.cpuMachineArgs(accel),
			'-smp', String(spec.cpus), '-m', String(spec.memoryMB),
			...this.dataDirArgs(qemu),
			...this.firmwareArgs(qemu),
			'-drive', `file=${overlay},if=virtio`,
			'-drive', `file=${seed},if=virtio,format=raw`,
			'-netdev', `user,id=n0,hostfwd=tcp:127.0.0.1:${port}-:22`, '-device', 'virtio-net-pci,netdev=n0',
			// NB: no -virtfs/9p here — the host project folder is shared via sshfs
			// under the remote model, so the VM needs no 9p mount.
			'-display', 'none', '-serial', `file:${path.join(this.dir, 'console.log')}`,
		];
	}

	// --- vfkit (Apple Silicon) ----------------------------------------------

	private async startVfkit(progress: ProgressFn, log: (line: string) => void): Promise<BootedVm> {
		const { vfkit, gvproxy } = await this.provisioner.ensureVfkit(progress);
		const qemuImgBin = this.qemuImg(await this.provisioner.ensureQemu(progress));
		const image = await this.provisioner.ensureImage(progress);

		const key = await this.ensureKey();
		const seed = await this.buildVfkitSeed(key + '.pub');
		const port = await this.freePort();
		const disk = path.join(this.dir, 'disk.raw');
		const efi = path.join(this.dir, 'efi-vars.nvram');
		const netSock = `/tmp/aria-${port}-net.sock`;
		const vfkitSock = `/tmp/aria-${port}-vfk.sock`;
		const consoleLog = path.join(this.dir, 'console.log');
		const spec = this.spec();

		if (!fs.existsSync(disk)) {
			progress('Preparing the run environment disk…');
			await execFileAsync(qemuImgBin, ['convert', '-f', 'qcow2', '-O', 'raw', image, disk], { windowsHide: true });
		}
		for (const f of [efi, netSock, vfkitSock]) { try { fs.rmSync(f, { force: true }); } catch { /* ignore */ } }

		// gvproxy: guest gets 192.168.127.2, gateway 192.168.127.1.
		const gvErr = fs.openSync(path.join(this.dir, 'gvproxy-stderr.log'), 'w');
		this.gvproxyProc = spawn(gvproxy, ['-listen', `unix://${netSock}`, '--listen-vfkit', `unixgram://${vfkitSock}`],
			{ stdio: ['ignore', 'ignore', gvErr], windowsHide: true });
		this.gvproxyProc.on('exit', () => { try { fs.closeSync(gvErr); } catch { /* already closed */ } });
		await this.waitForFile(vfkitSock, 10_000);
		await this.gvproxyExpose(netSock, `127.0.0.1:${port}`, '192.168.127.2:22');

		const args = [
			'--cpus', String(spec.cpus), '--memory', String(spec.memoryMB),
			'--bootloader', `efi,variable-store=${efi},create`,
			'--device', `virtio-blk,path=${disk}`,
			'--device', `virtio-blk,path=${seed}`,
			'--device', `virtio-net,unixSocketPath=${vfkitSock}`,
			'--device', `virtio-serial,logFilePath=${consoleLog}`,
		];
		const errLog = fs.openSync(path.join(this.dir, 'vfkit-stderr.log'), 'w');
		const proc = spawn(vfkit, args, { stdio: ['ignore', 'ignore', errLog], windowsHide: true });
		this.proc = proc;
		proc.on('exit', () => { try { fs.closeSync(errLog); } catch { /* already closed */ } });

		try {
			await this.waitForSsh('127.0.0.1', port, key);
			log(`[aria-remote] VM ready (vfkit) on 127.0.0.1:${port}`);
			return this.bootedVm('127.0.0.1', port, key);
		} catch (err) {
			try { this.proc?.kill('SIGKILL'); } catch { /* ignore */ }
			try { this.gvproxyProc?.kill('SIGKILL'); } catch { /* ignore */ }
			this.proc = undefined; this.gvproxyProc = undefined;
			throw err instanceof Error ? err : new Error(String(err));
		}
	}

	private gvproxyExpose(apiSock: string, local: string, remote: string): Promise<void> {
		return new Promise((resolve, reject) => {
			const body = JSON.stringify({ local, remote });
			const req = http.request(
				{ socketPath: apiSock, path: '/services/forwarder/expose', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } },
				(res) => { res.resume(); if (res.statusCode && res.statusCode < 300) { resolve(); } else { reject(new Error(`gvproxy expose failed (HTTP ${res.statusCode})`)); } });
			req.on('error', reject);
			req.write(body);
			req.end();
		});
	}

	private async waitForFile(p: string, timeoutMs: number): Promise<void> {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			if (fs.existsSync(p)) { return; }
			await new Promise(r => setTimeout(r, 100));
		}
		throw new Error(`gvproxy did not create ${path.basename(p)} in time (see gvproxy-stderr.log).`);
	}

	// --- cloud-init seeds (no 9p mount) -------------------------------------

	private async buildSeed(pubPath: string): Promise<string> {
		const seed = path.join(this.dir, 'seed.img');
		const pub = fs.readFileSync(pubPath, 'utf8').trim();
		const userData = [
			'#cloud-config',
			'users:',
			`  - name: ${GUEST_USER}`,
			'    groups: [sudo, docker]',
			'    sudo: ALL=(ALL) NOPASSWD:ALL',
			'    shell: /bin/bash',
			'    ssh_authorized_keys:',
			`      - ${pub}`,
			'ssh_pwauth: false',
			'runcmd:',
			// The sshfs mount point for the host project folder; the file-share step
			// mounts into it after boot.
			`  - mkdir -p ${GUEST_HOME}/project && chown ${GUEST_USER}:${GUEST_USER} ${GUEST_HOME}/project`,
			// docker baked into the image; idempotent fallback only.
			'  - command -v docker >/dev/null 2>&1 || (curl -fsSL https://get.docker.com | sh)',
			`  - usermod -aG docker ${GUEST_USER} || true`,
		].join('\n') + '\n';
		const metaData = 'instance-id: aria-vm\nlocal-hostname: aria\n';
		const img = buildFatSeedImage([
			{ name: 'user-data', data: Buffer.from(userData, 'utf8') },
			{ name: 'meta-data', data: Buffer.from(metaData, 'utf8') },
		]);
		fs.writeFileSync(seed, img);
		return seed;
	}

	private async buildVfkitSeed(pubPath: string): Promise<string> {
		const dir = path.join(this.dir, 'seed-src');
		fs.mkdirSync(dir, { recursive: true });
		const pub = fs.readFileSync(pubPath, 'utf8').trim();
		fs.writeFileSync(path.join(dir, 'meta-data'), 'instance-id: aria-vm\nlocal-hostname: aria\n');
		fs.writeFileSync(path.join(dir, 'network-config'), [
			'version: 2', 'ethernets:', '  all:', '    match:', '      name: "e*"',
			'    addresses: [192.168.127.2/24]', '    routes:', '      - {to: default, via: 192.168.127.1}',
			'    nameservers:', '      addresses: [192.168.127.1]', '',
		].join('\n'));
		fs.writeFileSync(path.join(dir, 'user-data'), [
			'#cloud-config', 'users:', `  - name: ${GUEST_USER}`, '    groups: [sudo, docker]',
			'    sudo: ALL=(ALL) NOPASSWD:ALL', '    shell: /bin/bash', '    ssh_authorized_keys:',
			`      - ${pub}`, 'ssh_pwauth: false', 'runcmd:',
			`  - mkdir -p ${GUEST_HOME}/project && chown ${GUEST_USER}:${GUEST_USER} ${GUEST_HOME}/project`,
			'  - command -v docker >/dev/null 2>&1 || (curl -fsSL https://get.docker.com | sh)',
			`  - usermod -aG docker ${GUEST_USER} || true`, '',
		].join('\n'));
		const iso = path.join(this.dir, 'seed.iso');
		try { fs.rmSync(iso); } catch { /* first run */ }
		await execFileAsync('hdiutil', ['makehybrid', '-o', iso, '-iso', '-joliet', '-default-volume-name', 'cidata', dir], { windowsHide: true });
		return iso;
	}

	// --- helpers ------------------------------------------------------------

	private bootedVm(host: string, port: number, keyPath: string): BootedVm {
		return { host, port, username: GUEST_USER, privateKeyPath: keyPath, stop: () => this.stop() };
	}

	/** VM size from settings, clamped to this host's physical ceiling. */
	private spec(): VmSpec {
		const cfg = vscode.workspace.getConfiguration('aria.remote');
		const maxCpus = Math.max(1, os.cpus().length);
		const maxMemoryMB = Math.max(1024, Math.floor((os.totalmem() / (1024 * 1024)) * 0.75));
		return {
			cpus: Math.max(1, Math.min(cfg.get<number>('vm.cpus', 2), maxCpus)),
			memoryMB: Math.max(1024, Math.min(cfg.get<number>('vm.memoryMB', 4096), maxMemoryMB)),
			diskGB: Math.max(20, cfg.get<number>('vm.diskGB', 60)),
		};
	}

	private qemuImg(qemu: string): string {
		const exe = process.platform === 'win32' ? '.exe' : '';
		const cand = path.join(path.dirname(qemu), `qemu-img${exe}`);
		return fs.existsSync(cand) ? cand : `qemu-img${exe}`;
	}

	private accel(): string {
		switch (process.platform) {
			case 'darwin': return 'hvf';
			case 'win32': return 'whpx';
			default: return 'kvm';
		}
	}

	private cpuMachineArgs(accel: string): string[] {
		const machine = this.machineType();
		if (accel === 'tcg') { return ['-machine', machine, '-accel', 'tcg', '-cpu', 'max']; }
		if (accel === 'whpx') { return ['-machine', machine, '-accel', 'whpx']; }
		return ['-machine', machine, '-accel', accel, '-cpu', 'host'];
	}

	private machineType(): string { return process.arch === 'arm64' ? 'virt' : 'q35'; }

	private dataDirArgs(qemu: string): string[] {
		const share = path.join(path.dirname(qemu), '..', 'share', 'qemu');
		return fs.existsSync(share) ? ['-L', share] : [];
	}

	private firmwareArgs(qemu: string): string[] {
		if (process.arch !== 'arm64') { return []; }
		const share = path.join(path.dirname(qemu), '..', 'share', 'qemu');
		for (const fw of ['edk2-aarch64-code.fd', 'AAVMF_CODE.fd']) {
			const p = path.join(share, fw);
			if (fs.existsSync(p)) { return ['-bios', p]; }
		}
		return ['-bios', '/opt/homebrew/share/qemu/edk2-aarch64-code.fd'];
	}

	private async ensureKey(): Promise<string> {
		const key = path.join(this.dir, 'id_ed25519');
		if (!fs.existsSync(key)) {
			await execFileAsync('ssh-keygen', ['-t', 'ed25519', '-N', '', '-f', key, '-q'], { windowsHide: true });
		}
		return key;
	}

	private freePort(): Promise<number> {
		return new Promise((resolve, reject) => {
			const srv = net.createServer();
			srv.listen(0, '127.0.0.1', () => {
				const p = (srv.address() as net.AddressInfo).port;
				srv.close(() => resolve(p));
			});
			srv.on('error', reject);
		});
	}

	/** Poll the VM over ssh2 until it answers or we time out / the VM dies. */
	private async waitForSsh(host: string, port: number, keyPath: string): Promise<void> {
		const deadline = Date.now() + READY_TIMEOUT_MS;
		const privateKey = fs.readFileSync(keyPath);
		while (Date.now() < deadline) {
			if (this.proc && this.proc.exitCode !== null) { throw new Error('VM process exited before SSH came up.'); }
			if (await this.canConnect(host, port, GUEST_USER, privateKey)) { return; }
			await new Promise(r => setTimeout(r, 3000));
		}
		throw new Error('Timed out waiting for the VM to become reachable.');
	}

	private canConnect(host: string, port: number, username: string, privateKey: Buffer): Promise<boolean> {
		return new Promise((resolve) => {
			const conn = new Client();
			let done = false;
			const finish = (ok: boolean) => { if (!done) { done = true; try { conn.end(); } catch { /* ignore */ } resolve(ok); } };
			conn.on('ready', () => finish(true));
			conn.on('error', () => finish(false));
			try {
				conn.connect({ host, port, username, privateKey, readyTimeout: 3000 });
			} catch {
				finish(false);
			}
		});
	}

	private killAndWait(p: ChildProcess): Promise<void> {
		return new Promise<void>((resolve) => {
			if (p.exitCode !== null || p.signalCode !== null) { resolve(); return; }
			let settled = false;
			const finish = (): void => { if (!settled) { settled = true; resolve(); } };
			p.once('exit', finish);
			try { p.kill('SIGTERM'); } catch { /* already gone */ }
			setTimeout(() => { try { p.kill('SIGKILL'); } catch { /* ignore */ } finish(); }, 3000);
		});
	}
}
