/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { spawn, ChildProcess, execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as net from 'net';
import * as path from 'path';
import { ConfigService } from '../config/configService';
import { LOCAL_VM_ID, SshProfile } from '../common/types';
import { Provisioner, ProgressFn } from './provisioner';
import { buildFatSeedImage } from './fatSeed';
import { SshService } from '../ssh/sshService';

const execFileAsync = promisify(execFile);

/**
 * Manages the built-in local VM ("Aria built-in" Run environment). The VM is a
 * headless QEMU Linux guest with docker + sshd; autopipe talks to it exactly
 * like any SSH server (it's exposed as a synthetic SshProfile on 127.0.0.1).
 *
 * Two modes:
 *  - REAL: boot QEMU (Mac=HVF / Win=WHPX / Linux=KVM). Needs a base image + the
 *    qemu binary. This is the production path (image comes from GitHub Releases
 *    in M4; for dev you can point ARIA_AUTOPIPE_VM_IMAGE / ARIA_QEMU_PATH).
 *  - STAND-IN (dev): when ARIA_AUTOPIPE_VM_STANDIN is set, skip QEMU and treat a
 *    given SSH endpoint as the "VM". Lets Linux dev boxes (no qemu/KVM) test the
 *    whole activation + pipeline flow against a real docker host.
 *
 * Either way, once reachable it registers a synthetic SshProfile via
 * ConfigService.setLocalVmEndpoint so every existing autopipe path just works.
 */

export type VmStatus = 'stopped' | 'provisioning' | 'booting' | 'ready' | 'error';

interface StandinSpec { host: string; port: number; username: string; key_path: string; repo_path: string }

const GUEST_USER = 'aria';
const GUEST_REPO = `/home/${GUEST_USER}/aria`;
const READY_TIMEOUT_MS = 180_000;

export class VMManager {
	private _status: VmStatus = 'stopped';
	private _error: string | undefined;
	private _progress: { message: string; pct?: number } | undefined;
	private proc: ChildProcess | undefined;
	private starting: Promise<void> | undefined;
	private readonly _onDidChange = new vscode.EventEmitter<VmStatus>();
	readonly onDidChangeStatus = this._onDidChange.event;
	private readonly _onProgress = new vscode.EventEmitter<{ message: string; pct?: number }>();
	readonly onProgress = this._onProgress.event;

	private readonly dir: string;              // per-install VM assets
	private readonly workspace: string;        // host side of the 9p share (repo)
	private readonly provisioner: Provisioner;
	private readonly ssh = new SshService();   // ssh2-based reachability probe

	constructor(context: vscode.ExtensionContext, private readonly config: ConfigService) {
		this.dir = path.join(context.globalStorageUri.fsPath, 'vm');
		this.workspace = path.join(context.globalStorageUri.fsPath, 'autopipe-workspace');
		fs.mkdirSync(this.dir, { recursive: true });
		fs.mkdirSync(this.workspace, { recursive: true });
		this.provisioner = new Provisioner(this.dir);
	}

	status(): VmStatus { return this._status; }
	lastError(): string | undefined { return this._error; }
	progress(): { message: string; pct?: number } | undefined { return this._progress; }

	private set(status: VmStatus, error?: string): void {
		this._status = status; this._error = error;
		this._onDidChange.fire(status);
	}

	/** The dev stand-in spec, if configured (ARIA_AUTOPIPE_VM_STANDIN as JSON). */
	private standin(): StandinSpec | undefined {
		const raw = process.env.ARIA_AUTOPIPE_VM_STANDIN
			?? vscode.workspace.getConfiguration('aria.autopipe').get<string>('vmStandin');
		if (!raw) { return undefined; }
		try {
			const s = JSON.parse(raw) as Partial<StandinSpec>;
			if (!s.host || !s.username || !s.key_path) { return undefined; }
			return { host: s.host, port: s.port ?? 22, username: s.username, key_path: s.key_path, repo_path: s.repo_path ?? GUEST_REPO };
		} catch { return undefined; }
	}

	/** Start (idempotent). Registers the SSH endpoint on success. */
	async start(): Promise<void> {
		if (this._status === 'ready') { return; }
		if (this.starting) { return this.starting; }
		this.starting = (async () => {
			try {
				const standin = this.standin();
				if (standin) {
					await this.startStandin(standin);
				} else {
					await this.startReal();
				}
			} catch (err) {
				this.set('error', err instanceof Error ? err.message : String(err));
				this.config.setLocalVmEndpoint(null);
				throw err;
			} finally {
				this.starting = undefined;
			}
		})();
		return this.starting;
	}

	/** Dev stand-in: verify the SSH host is reachable, then expose it as the VM. */
	private async startStandin(s: StandinSpec): Promise<void> {
		this.set('booting');
		const profile = this.profileFor(s.host, s.port, s.username, s.key_path, s.repo_path);
		await this.waitForSsh(profile);
		this.config.setLocalVmEndpoint(profile);
		this.set('ready');
	}

	/** Real QEMU boot — provisions the portable qemu + image first (downloaded from
	 *  GitHub Releases into app-data), then boots headless. */
	private async startReal(): Promise<void> {
		this.set('provisioning');
		const progress: ProgressFn = (message, pct) => {
			this._progress = { message: message ?? this._progress?.message ?? '', pct };
			this._onProgress.fire(this._progress);
		};
		const qemu = await this.provisioner.ensureQemu(progress);
		const image = await this.provisioner.ensureImage(progress);

		this.set('booting');
		const key = await this.ensureKey();
		const port = await this.freePort();
		const overlay = path.join(this.dir, 'overlay.qcow2');
		const seed = await this.buildSeed(key + '.pub');
		const qimg = this.qemuImg(qemu);

		// Mac/Linux: a fresh overlay each boot keeps the base image pristine because
		// user DATA lives on the 9p-shared host workspace, not the overlay.
		// Windows: qemu has no 9p/virtfs, so there is NO host share — user data
		// lives inside the guest overlay, so we must PERSIST it across boots (never
		// wipe; only create it the first time) or every restart loses the workspace.
		const createArgs = ['create', '-f', 'qcow2', '-F', 'qcow2', '-b', image, overlay, `${this.config.get().local_vm.diskGB}G`];
		if (process.platform === 'win32') {
			if (!fs.existsSync(overlay)) {
				await execFileAsync(qimg, createArgs, { windowsHide: true });
			}
		} else {
			if (fs.existsSync(overlay)) { fs.rmSync(overlay); }
			await execFileAsync(qimg, createArgs, { windowsHide: true });
		}

		const vm = this.config.get().local_vm;
		// Boot with hardware acceleration first, but fall back to (slow) TCG
		// software emulation if qemu exits before SSH comes up. That covers a
		// broken host accelerator such as the QEMU HVF/SME assertion crash seen on
		// some Apple Silicon Macs, or a Windows host without the Hypervisor
		// Platform feature — the VM still boots, just slower.
		const primary = this.accel();
		const accels = primary === 'tcg' ? ['tcg'] : [primary, 'tcg'];
		const sshProfile = this.profileFor('127.0.0.1', port, GUEST_USER, key, GUEST_REPO);
		let lastErr: Error | undefined;
		for (let i = 0; i < accels.length; i++) {
			const args = this.buildQemuArgs(accels[i], vm, qemu, overlay, seed, port);
			// Capture QEMU's own stderr (accel/argument errors) to qemu-stderr.log
			// so a silent timeout is still diagnosable.
			const errLog = fs.openSync(path.join(this.dir, 'qemu-stderr.log'), 'w');
			this.proc = spawn(qemu, args, { stdio: ['ignore', 'ignore', errLog], windowsHide: true });
			this.proc.on('exit', (code) => {
				try { fs.closeSync(errLog); } catch { /* already closed */ }
				// Only a hard error once we're READY (qemu died mid-run). During
				// boot, waitForSsh detects the exit and the loop below retries.
				if (this._status === 'ready') {
					this.set('error', `VM exited unexpectedly (code ${code}; see qemu-stderr.log / console.log).`);
					this.config.setLocalVmEndpoint(null);
				}
			});
			try {
				await this.waitForSsh(sshProfile);
				this.config.setLocalVmEndpoint(sshProfile);
				this.set('ready');
				return;
			} catch (err) {
				lastErr = err instanceof Error ? err : new Error(String(err));
				try { this.proc?.kill('SIGKILL'); } catch { /* ignore */ }
				this.proc = undefined;
				if (i < accels.length - 1) {
					progress('Hardware acceleration unavailable — retrying with software emulation (slower)…');
				}
			}
		}
		throw lastErr ?? new Error('The VM failed to start.');
	}

	/** Assemble the qemu command line for one accelerator choice. */
	private buildQemuArgs(accel: string, vm: { cpus: number; memoryMB: number }, qemu: string, overlay: string, seed: string, port: number): string[] {
		return [
			'-name', 'aria-builtin', ...this.cpuMachineArgs(accel),
			'-smp', String(vm.cpus), '-m', String(vm.memoryMB),
			...this.dataDirArgs(qemu),
			...this.firmwareArgs(qemu),
			'-drive', `file=${overlay},if=virtio`,
			// Seed as a virtio disk (not media=cdrom): cloud-init finds it by the
			// `cidata` label, and virtio attaches cleanly on both q35 and arm64 virt.
			'-drive', `file=${seed},if=virtio,format=raw`,
			'-netdev', `user,id=n0,hostfwd=tcp:127.0.0.1:${port}-:22`, '-device', 'virtio-net-pci,netdev=n0',
			// 9p host-workspace share — Linux/macOS qemu only. The Windows qemu build
			// (choco) has virtfs DISABLED, and passing -virtfs makes it exit at start
			// ("There is no option group 'virtfs'"). Omit it there; the guest keeps
			// its data in the persisted overlay instead (see overlay handling above).
			...(process.platform === 'win32'
				? []
				: ['-virtfs', `local,path=${this.workspace},mount_tag=aria,security_model=mapped-xattr,id=aria`]),
			'-display', 'none', '-serial', `file:${path.join(this.dir, 'console.log')}`,
		];
	}

	async stop(): Promise<void> {
		this.set('stopped');
		this.config.setLocalVmEndpoint(null);
		if (this.proc) { try { this.proc.kill('SIGTERM'); } catch { /* ignore */ } this.proc = undefined; }
	}

	async reset(): Promise<void> {
		await this.stop();
		try { fs.rmSync(path.join(this.dir, 'overlay.qcow2')); } catch { /* ignore */ }
		// Base image + workspace are kept: reset only recreates the throwaway overlay.
	}

	dispose(): void { void this.stop(); this._onDidChange.dispose(); this._onProgress.dispose(); }

	// --- helpers ------------------------------------------------------------

	private profileFor(host: string, port: number, username: string, keyPath: string, repo: string): SshProfile {
		return { id: LOCAL_VM_ID, name: 'Aria built-in', host, port, username, auth: { type: 'key', key_path: keyPath }, repo_path: repo };
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

	/** `-machine`/`-accel`/`-cpu` args for a specific accelerator. `-cpu host`
	 *  requires a hardware accelerator; TCG (software) needs `-cpu max` instead. */
	private cpuMachineArgs(accel: string): string[] {
		return accel === 'tcg'
			? ['-machine', this.machineType(), '-accel', 'tcg', '-cpu', 'max']
			: ['-machine', this.machineType(), '-accel', accel, '-cpu', 'host'];
	}

	/** Machine type per guest arch: Apple Silicon (arm64) uses `virt` (+UEFI);
	 *  x86_64 uses `q35`. */
	private machineType(): string { return process.arch === 'arm64' ? 'virt' : 'q35'; }

	/** Point qemu at its data blobs (BIOS/vgabios/keymaps) so a relocated/portable
	 *  build finds them. Works for the bundled qemu (`<qemuDir>/share/qemu`) and a
	 *  system one (e.g. Homebrew's `../share/qemu`) alike. */
	private dataDirArgs(qemu: string): string[] {
		const share = path.join(path.dirname(qemu), '..', 'share', 'qemu');
		return fs.existsSync(share) ? ['-L', share] : [];
	}

	/** arm64 `virt` boots via UEFI, so it needs the edk2 firmware; x86_64 q35 uses
	 *  the built-in BIOS and needs nothing. Firmware ships next to the qemu binary
	 *  (Homebrew: ../share/qemu/edk2-aarch64-code.fd). */
	private firmwareArgs(qemu: string): string[] {
		if (process.arch !== 'arm64') { return []; }
		const share = path.join(path.dirname(qemu), '..', 'share', 'qemu');
		for (const fw of ['edk2-aarch64-code.fd', 'AAVMF_CODE.fd']) {
			const p = path.join(share, fw);
			if (fs.existsSync(p)) { return ['-bios', p]; }
		}
		// Fall back to a well-known Homebrew path; if absent qemu will error clearly.
		return ['-bios', '/opt/homebrew/share/qemu/edk2-aarch64-code.fd'];
	}

	private async ensureKey(): Promise<string> {
		const key = path.join(this.dir, 'id_ed25519');
		if (!fs.existsSync(key)) {
			await execFileAsync('ssh-keygen', ['-t', 'ed25519', '-N', '', '-f', key, '-q'], { windowsHide: true });
		}
		return key;
	}

	/** Build a cloud-init NoCloud seed that injects the SSH pubkey + mounts the 9p
	 *  workspace. (The production prebuilt image bakes in docker/user; this seed
	 *  only carries per-user bits.)
	 *
	 *  The seed is a FAT12 image built in pure JS (fatSeed.ts) rather than an
	 *  ISO — cloud-init reads `user-data`/`meta-data` from any `cidata`-labelled
	 *  filesystem, and a hand-built FAT image needs NO external tool, so the
	 *  built-in VM works on a vanilla Windows box (no oscdimg/mkisofs there). */
	private async buildSeed(pubPath: string): Promise<string> {
		const seed = path.join(this.dir, 'seed.img');
		const pub = fs.readFileSync(pubPath, 'utf8').trim();
		const userData = [
			'#cloud-config',
			'users:',
			`  - name: ${GUEST_USER}`,
			'    groups: [sudo]',
			'    sudo: ALL=(ALL) NOPASSWD:ALL',
			'    shell: /bin/bash',
			'    ssh_authorized_keys:',
			`      - ${pub}`,
			'ssh_pwauth: false',
			'runcmd:',
			`  - mkdir -p ${GUEST_REPO} && chown ${GUEST_USER}:${GUEST_USER} ${GUEST_REPO}`,
			`  - mount -t 9p -o trans=virtio,version=9p2000.L aria ${GUEST_REPO} || true`,
			`  - chown ${GUEST_USER}:${GUEST_USER} ${GUEST_REPO}`,
			// Ensure docker + the aria docker group. Idempotent: a no-op on the
			// prebuilt image (docker baked in); installs it on a vanilla image.
			'  - command -v docker >/dev/null 2>&1 || (curl -fsSL https://get.docker.com | sh)',
			`  - usermod -aG docker ${GUEST_USER} || true`,
		].join('\n') + '\n';
		const metaData = 'instance-id: aria-builtin\nlocal-hostname: aria\n';
		const img = buildFatSeedImage([
			{ name: 'user-data', data: Buffer.from(userData, 'utf8') },
			{ name: 'meta-data', data: Buffer.from(metaData, 'utf8') },
		]);
		fs.writeFileSync(seed, img);
		return seed;
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
	private async waitForSsh(p: SshProfile): Promise<void> {
		const deadline = Date.now() + READY_TIMEOUT_MS;
		while (Date.now() < deadline) {
			if (this.proc && this.proc.exitCode !== null) { throw new Error('VM process exited before SSH came up.'); }
			if (await this.ssh.canConnect(p, 3000)) { return; }
			await new Promise(r => setTimeout(r, 3000));
		}
		throw new Error('Timed out waiting for the VM to become reachable.');
	}
}
