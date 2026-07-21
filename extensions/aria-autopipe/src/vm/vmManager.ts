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
import * as path from 'path';
import { ConfigService } from '../config/configService';
import { LOCAL_VM_ID, SshProfile, hostVmLimits } from '../common/types';
import { Provisioner, ProgressFn } from './provisioner';
import { buildFatSeedImage } from './fatSeed';
import { SshService } from '../ssh/sshService';
import { wslAvailable, listDistros, pickDistro, defaultUser, runAsRoot, launchDistroTerminal, provisionScript, keeperScript, wslExePath } from './wsl';
import { windowsToWsl } from '../common/dockerEnv';
import { ensureWorkspaceScaffold } from '../common/workspaceSync';

const execFileAsync = promisify(execFile);

/**
 * Manages the built-in local VM ("Qoka built-in" Run environment). The VM is a
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
// Generous: a FIRST boot runs cloud-init (which mounts the seed, creates the
// user + SSH key, then starts sshd) and, on a software-emulated (TCG) fallback,
// the whole guest runs many times slower. 180s wasn't enough - the guest was
// still mid-cloud-init when we gave up. sshd comes up well before this ceiling
// on a hardware-accelerated boot; the extra headroom only matters for slow ones.
const READY_TIMEOUT_MS = 360_000;

export class VMManager {
	private _status: VmStatus = 'stopped';
	private _error: string | undefined;
	private _progress: { message: string; pct?: number } | undefined;
	private proc: ChildProcess | undefined;
	private gvproxyProc: ChildProcess | undefined;   // macOS vfkit networking helper
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

	/** Physical ceiling of THIS machine, for sizing and validating the local VM.
	 *  The VM runs on the user's own computer, so these are the real limits the
	 *  settings UI should show and enforce. Memory is capped below physical RAM:
	 *  the host OS needs headroom, and vfkit/VZ rejects any memorySize above its
	 *  own maximumAllowedMemorySize (which sits a little under physical). */
	hostLimits(): { maxCpus: number; maxMemoryMB: number } {
		return hostVmLimits();
	}

	/** The configured VM size clamped to what this host can actually provide, so
	 *  a config carried over from a bigger remote box (e.g. 32 CPU / 100 GB) can
	 *  never exceed the local machine and crash the VM at launch. */
	private hostSafeSpec(): { cpus: number; memoryMB: number } {
		const vm = this.config.get().local_vm;
		const lim = this.hostLimits();
		return {
			cpus: Math.max(1, Math.min(vm.cpus, lim.maxCpus)),
			memoryMB: Math.max(1024, Math.min(vm.memoryMB, lim.maxMemoryMB)),
		};
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

	/** Provision + boot the built-in VM. macOS uses vfkit (Apple VZ - works on
	 *  every Apple Silicon generation); Windows/Linux use portable QEMU. */
	private async startReal(): Promise<void> {
		this.set('provisioning');
		const progress: ProgressFn = (message, pct) => {
			this._progress = { message: message ?? this._progress?.message ?? '', pct };
			this._onProgress.fire(this._progress);
		};
		// Windows → WSL2 (Ubuntu distro with sshd + docker), replacing the QEMU
		// path. Apple Silicon → vfkit (qemu's HVF asserts on M4). Intel Macs and
		// Linux keep qemu+HVF/KVM.
		if (process.platform === 'win32') {
			await this.startWsl(progress);
		} else if (process.platform === 'darwin' && process.arch === 'arm64') {
			await this.startVfkit(progress);
		} else {
			await this.startQemu(progress);
		}
	}

	/** Windows boot path: provision a WSL2 Ubuntu distro (openssh-server + docker)
	 *  and expose it as the built-in run target via a synthetic SshProfile. No
	 *  QEMU, no REH/resolver - WSL2 localhost forwarding makes the distro's sshd
	 *  reachable at 127.0.0.1:<port>, and the whole autopipe stack keeps talking
	 *  to it as an ordinary SSH host.
	 *
	 *  The WSL feature + Ubuntu distro are installed by the Qoka installer
	 *  (`wsl --install -d Ubuntu`); the user creates the UNIX account at Ubuntu's
	 *  first run. Everything below (docker + sshd + tools) is done automatically
	 *  and is idempotent, so it converges on repeated launches. */
	private async startWsl(progress: ProgressFn): Promise<void> {
		if (!await wslAvailable()) {
			throw new Error('WSL is not installed. Reinstall Qoka (which installs WSL) or run "wsl --install" in an admin terminal, then reboot.');
		}

		const distro = pickDistro(await listDistros());
		if (!distro) {
			// The WSL engine is present (wslAvailable passed) but no distribution is
			// registered - `wsl --version` still succeeds in this state, which
			// confuses users. Be explicit that a distro must be installed.
			throw new Error('WSL is installed but no Linux distribution was found (run "wsl -l -v" to confirm it is empty). Install one and create an account: run "wsl --install -d Ubuntu", then open Ubuntu once to set a username and password, and try again.');
		}

		// Ubuntu's first-run account step sets a non-root default user. Until the
		// user has completed it, the default user is root - open the distro so they
		// can create the account, then ask them to retry.
		const user = await defaultUser(distro);
		if (!user || user === 'root') {
			await launchDistroTerminal(distro);
			throw new Error(`Finish setting up ${distro}: a terminal was opened - create your Linux username and password, then click "Set up now" again.`);
		}

		this.set('booting');
		progress('Setting up the WSL run environment (docker, tools)…');

		const key = await this.ensureKey();
		const pub = fs.readFileSync(key + '.pub', 'utf8').trim();
		const port = await this.freePort();
		// Point the built-in server's workspace at the open PROJECT's autopipe/ dir,
		// seen through WSL's Windows mount (/mnt/<drive>/…). The guest then reads and
		// writes pipeline code + outputs DIRECTLY on the user's local disk - no SFTP
		// copy, no mirroring, and VS Code sees changes live. Falls back to a guest
		// home dir when no folder is open (results then need an explicit save).
		const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		let repo: string;
		if (wsRoot) {
			ensureWorkspaceScaffold(wsRoot);
			repo = windowsToWsl(path.join(wsRoot, 'autopipe'));
		} else {
			repo = `/home/${user}/aria`;
		}

		// 1) One-shot provisioning (idempotent): install docker + openssh-server,
		//    inject the key, generate host keys. No services started here - WSL
		//    would tear them down when this session exits.
		const out = await runAsRoot(distro, provisionScript(user, pub, repo));
		if (!out.includes('QOKA_PROVISION_OK')) {
			throw new Error('Failed to set up docker/sshd inside WSL. See the Qoka output for details.');
		}

		// 2) Keeper: a foreground sshd (-D) held open as a managed child. WSL has no
		//    systemd on a stock distro, so backgrounded daemons die when their
		//    launching session ends; keeping this wsl.exe alive holds the distro +
		//    sshd (and the dockerd it starts) up for the life of the app. Mirrors the
		//    QEMU proc lifecycle - stop()/dispose() kill it.
		const errLog = fs.openSync(path.join(this.dir, 'wsl-keeper.log'), 'w');
		const proc = spawn(
			wslExePath(),
			['-d', distro, '-u', 'root', '--', 'bash', '-c', keeperScript(port)],
			{ stdio: ['ignore', 'ignore', errLog], windowsHide: true },
		);
		this.proc = proc;
		proc.on('exit', (code) => {
			try { fs.closeSync(errLog); } catch { /* already closed */ }
			// Ignore a stale exit after a restart replaced this process.
			if (this.proc !== proc) { return; }
			if (this._status === 'ready') {
				this.set('error', `The WSL run environment exited unexpectedly (code ${code}; see wsl-keeper.log).`);
				this.config.setLocalVmEndpoint(null);
			}
		});

		const sshProfile = this.profileFor('127.0.0.1', port, user, key, repo);
		try {
			await this.waitForSsh(sshProfile);
			this.config.setLocalVmEndpoint(sshProfile);
			this.set('ready');
		} catch (err) {
			try { this.proc?.kill('SIGKILL'); } catch { /* ignore */ }
			this.proc = undefined;
			throw err instanceof Error ? err : new Error(String(err));
		}
	}

	/** Windows/Linux boot path: portable QEMU with WHPX/KVM and a TCG fallback. */
	private async startQemu(progress: ProgressFn): Promise<void> {
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
		// Windows: qemu has no 9p/virtfs, so there is NO host share - user data
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

		const vm = this.hostSafeSpec();
		// Boot with hardware acceleration first, but fall back to (slow) TCG
		// software emulation if qemu exits before SSH comes up. That covers a
		// broken host accelerator such as the QEMU HVF/SME assertion crash seen on
		// some Apple Silicon Macs, or a Windows host without the Hypervisor
		// Platform feature - the VM still boots, just slower.
		const primary = this.accel();
		const accels = primary === 'tcg' ? ['tcg'] : [primary, 'tcg'];
		const sshProfile = this.profileFor('127.0.0.1', port, GUEST_USER, key, GUEST_REPO);
		let lastErr: Error | undefined;
		for (let i = 0; i < accels.length; i++) {
			const args = this.buildQemuArgs(accels[i], vm, qemu, overlay, seed, port);
			// Capture QEMU's own stderr (accel/argument errors) to qemu-stderr.log
			// so a silent timeout is still diagnosable.
			const errLog = fs.openSync(path.join(this.dir, 'qemu-stderr.log'), 'w');
			const proc = spawn(qemu, args, { stdio: ['ignore', 'ignore', errLog], windowsHide: true });
			this.proc = proc;
			proc.on('exit', (code) => {
				try { fs.closeSync(errLog); } catch { /* already closed */ }
				// Ignore if a restart already replaced this process: otherwise the
				// OLD proc's late exit (SIGTERM from stop() isn't instant) fires
				// after the NEW VM is 'ready' and wrongly flips it to 'error'.
				if (this.proc !== proc) { return; }
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
					progress('Hardware acceleration unavailable - retrying with software emulation (slower)…');
				}
			}
		}
		throw lastErr ?? new Error('The VM failed to start.');
	}

	/** macOS boot path: vfkit (Apple Virtualization.framework) + gvproxy user-mode
	 *  networking. Works on every Apple Silicon generation (M1–M4) because it uses
	 *  Apple's VZ, not qemu's HVF (which asserts on M4). Like the Windows qemu
	 *  path there is NO host share; the guest keeps its data in the persisted raw
	 *  disk and docker is baked into the base image. */
	private async startVfkit(progress: ProgressFn): Promise<void> {
		const { vfkit, gvproxy } = await this.provisioner.ensureVfkit(progress);
		// qemu-img only, for the one-time qcow2 -> raw conversion. qemu-system is
		// never launched on Mac, so its broken HVF path is irrelevant.
		const qemuImgBin = this.qemuImg(await this.provisioner.ensureQemu(progress));
		const image = await this.provisioner.ensureImage(progress);

		this.set('booting');
		const key = await this.ensureKey();
		const seed = await this.buildVfkitSeed(key + '.pub');
		const port = await this.freePort();
		const disk = path.join(this.dir, 'disk.raw');
		const efi = path.join(this.dir, 'efi-vars.nvram');
		// Unix socket paths must stay under the macOS ~104-char sun_path limit, so
		// keep them in /tmp rather than the (long) globalStorage dir.
		const netSock = `/tmp/aria-${port}-net.sock`;
		const vfkitSock = `/tmp/aria-${port}-vfk.sock`;
		const consoleLog = path.join(this.dir, 'console.log');

		// One-time qcow2 -> raw conversion (VZ only boots raw images). Persist it:
		// it IS the guest's disk (no host share on Mac), rebuilt only when the base
		// image changes (the provisioner clears disk.raw on an image-tag bump).
		if (!fs.existsSync(disk)) {
			progress('Preparing the run environment disk…');
			await execFileAsync(qemuImgBin, ['convert', '-f', 'qcow2', '-O', 'raw', image, disk], { windowsHide: true });
		}
		// Fresh EFI variable store + sockets each boot (deterministic auto-boot).
		for (const f of [efi, netSock, vfkitSock]) { try { fs.rmSync(f, { force: true }); } catch { /* ignore */ } }

		const vm = this.hostSafeSpec();
		const sshProfile = this.profileFor('127.0.0.1', port, GUEST_USER, key, GUEST_REPO);

		// 1) gvproxy: creates the vfkit datagram socket + an API socket. Guest gets
		//    192.168.127.2 with gateway 192.168.127.1.
		const gvErr = fs.openSync(path.join(this.dir, 'gvproxy-stderr.log'), 'w');
		this.gvproxyProc = spawn(gvproxy, ['-listen', `unix://${netSock}`, '--listen-vfkit', `unixgram://${vfkitSock}`],
			{ stdio: ['ignore', 'ignore', gvErr], windowsHide: true });
		this.gvproxyProc.on('exit', () => { try { fs.closeSync(gvErr); } catch { /* already closed */ } });
		await this.waitForFile(vfkitSock, 10_000);
		// 2) Forward host 127.0.0.1:<port> -> guest 192.168.127.2:22.
		await this.gvproxyExpose(netSock, `127.0.0.1:${port}`, '192.168.127.2:22');

		// 3) vfkit boots the raw disk + cloud-init seed; networking over the socket.
		const args = [
			'--cpus', String(vm.cpus), '--memory', String(vm.memoryMB),
			'--bootloader', `efi,variable-store=${efi},create`,
			'--device', `virtio-blk,path=${disk}`,
			'--device', `virtio-blk,path=${seed}`,
			'--device', `virtio-net,unixSocketPath=${vfkitSock}`,
			'--device', `virtio-serial,logFilePath=${consoleLog}`,
		];
		const errLog = fs.openSync(path.join(this.dir, 'vfkit-stderr.log'), 'w');
		const proc = spawn(vfkit, args, { stdio: ['ignore', 'ignore', errLog], windowsHide: true });
		this.proc = proc;
		proc.on('exit', (code) => {
			try { fs.closeSync(errLog); } catch { /* already closed */ }
			// Ignore a stale exit after a restart replaced this process, or the
			// old vfkit's late SIGTERM exit would flip the freshly-booted VM to
			// 'error' ("running then not connected" on the restart button).
			if (this.proc !== proc) { return; }
			if (this._status === 'ready') {
				this.set('error', `VM exited unexpectedly (code ${code}; see vfkit-stderr.log / console.log).`);
				this.config.setLocalVmEndpoint(null);
			}
		});

		try {
			await this.waitForSsh(sshProfile);
			this.config.setLocalVmEndpoint(sshProfile);
			this.set('ready');
		} catch (err) {
			try { this.proc?.kill('SIGKILL'); } catch { /* ignore */ }
			try { this.gvproxyProc?.kill('SIGKILL'); } catch { /* ignore */ }
			this.proc = undefined; this.gvproxyProc = undefined;
			throw err instanceof Error ? err : new Error(String(err));
		}
	}

	/** POST a port-forward to gvproxy's REST API over its unix socket. */
	private gvproxyExpose(apiSock: string, local: string, remote: string): Promise<void> {
		return new Promise((resolve, reject) => {
			const body = JSON.stringify({ local, remote });
			const req = http.request(
				{ socketPath: apiSock, path: '/services/forwarder/expose', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } },
				(res) => {
					res.resume();
					if (res.statusCode && res.statusCode < 300) { resolve(); } else { reject(new Error(`gvproxy expose failed (HTTP ${res.statusCode})`)); }
				});
			req.on('error', reject);
			req.write(body);
			req.end();
		});
	}

	/** Poll until a path exists (gvproxy creating its vfkit datagram socket). */
	private async waitForFile(p: string, timeoutMs: number): Promise<void> {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			if (fs.existsSync(p)) { return; }
			await new Promise(r => setTimeout(r, 100));
		}
		throw new Error(`gvproxy did not create ${path.basename(p)} in time (see gvproxy-stderr.log).`);
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
			// 9p host-workspace share - Linux/macOS qemu only. The Windows qemu build
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
		const procs = [this.proc, this.gvproxyProc].filter((p): p is ChildProcess => !!p);
		this.proc = undefined;
		this.gvproxyProc = undefined;
		// WAIT for the processes to actually exit before returning. A restart calls
		// start() immediately after stop(); if we don't wait, the OLD VM can still
		// hold the disk image (overlay.qcow2 / disk.raw) open when the NEW one boots
		// - a hard failure under Windows' exclusive file locks - and its late exit
		// event can flip the freshly-booted VM to 'error'.
		await Promise.all(procs.map(p => this.killAndWait(p)));
	}

	/** SIGTERM a process and resolve once it exits, falling back to SIGKILL if it
	 *  lingers, so a caller (restart) can safely reuse its files afterwards. */
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

	async reset(): Promise<void> {
		await this.stop();
		try { fs.rmSync(path.join(this.dir, 'overlay.qcow2')); } catch { /* ignore */ }
		// Base image + workspace are kept: reset only recreates the throwaway overlay.
	}

	dispose(): void { void this.stop(); this._onDidChange.dispose(); this._onProgress.dispose(); }

	// --- helpers ------------------------------------------------------------

	private profileFor(host: string, port: number, username: string, keyPath: string, repo: string): SshProfile {
		return { id: LOCAL_VM_ID, name: 'Qoka built-in', host, port, username, auth: { type: 'key', key_path: keyPath }, repo_path: repo };
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

	/** `-machine`/`-accel`/`-cpu` args for a specific accelerator.
	 *  - hvf/kvm: `-cpu host` (host passthrough - required and fast).
	 *  - whpx: NO `-cpu host` - the Windows Hypervisor Platform rejects/degrades
	 *    the host model, which makes qemu fall back to (slow) TCG. Letting qemu
	 *    pick the machine default keeps WHPX engaged and fast.
	 *  - tcg: `-cpu max` (host is invalid under software emulation). */
	private cpuMachineArgs(accel: string): string[] {
		const machine = this.machineType();
		if (accel === 'tcg') {
			return ['-machine', machine, '-accel', 'tcg', '-cpu', 'max'];
		}
		if (accel === 'whpx') {
			return ['-machine', machine, '-accel', 'whpx'];
		}
		return ['-machine', machine, '-accel', accel, '-cpu', 'host'];
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
	 *  ISO - cloud-init reads `user-data`/`meta-data` from any `cidata`-labelled
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

	/** vfkit/macOS cloud-init seed (ISO via hdiutil). Two differences from the
	 *  qemu seed: (1) a STATIC IP of 192.168.127.2 so gvproxy's fixed forward
	 *  (host:port -> 192.168.127.2:22) always hits the guest - gvproxy's DHCP
	 *  hands out .3/.4/... unpredictably across boots; (2) no 9p mount (VZ has no
	 *  host share). Built as an ISO because that is the seed format verified to
	 *  mount under Apple VZ (the pure-JS FAT image is only proven under qemu). */
	private async buildVfkitSeed(pubPath: string): Promise<string> {
		const dir = path.join(this.dir, 'seed-src');
		fs.mkdirSync(dir, { recursive: true });
		const pub = fs.readFileSync(pubPath, 'utf8').trim();
		fs.writeFileSync(path.join(dir, 'meta-data'), 'instance-id: aria-builtin\nlocal-hostname: aria\n');
		fs.writeFileSync(path.join(dir, 'network-config'), [
			'version: 2',
			'ethernets:',
			'  all:',
			'    match:',
			'      name: "e*"',
			'    addresses: [192.168.127.2/24]',
			'    routes:',
			'      - {to: default, via: 192.168.127.1}',
			'    nameservers:',
			'      addresses: [192.168.127.1]',
			'',
		].join('\n'));
		fs.writeFileSync(path.join(dir, 'user-data'), [
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
			// Docker is baked into the image; this is an idempotent fallback only.
			'  - command -v docker >/dev/null 2>&1 || (curl -fsSL https://get.docker.com | sh)',
			`  - usermod -aG docker ${GUEST_USER} || true`,
			'',
		].join('\n'));
		const iso = path.join(this.dir, 'seed.iso');
		try { fs.rmSync(iso); } catch { /* first run */ }
		await execFileAsync('hdiutil', ['makehybrid', '-o', iso, '-iso', '-joliet', '-default-volume-name', 'cidata', dir], { windowsHide: true });
		return iso;
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
