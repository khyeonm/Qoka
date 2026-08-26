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
import { wslAvailable, listDistros, listDistrosStrict, isWslServiceError, pickDistro, installUbuntuDistro, defaultUser, runAsRoot, launchDistroTerminal, provisionScript, keeperScript, wslExePath, wslShutdown } from './wsl';
import { windowsToWsl } from '../common/dockerEnv';
import { ensureWorkspaceScaffold } from '../common/workspaceSync';

const execFileAsync = promisify(execFile);

/**
 * Manages the built-in local VM ("Qoka built-in" Run environment). The VM is a
 * headless QEMU Linux guest with docker + sshd; autopipe talks to it exactly
 * like any SSH server (it's exposed as a synthetic SshProfile on 127.0.0.1).
 *
 * Two modes:
 *  - REAL: boot QEMU (Intel Mac=HVF / Linux=KVM) or vfkit (Apple Silicon).
 *    Windows uses WSL instead (see startWsl). Needs a base image + the qemu
 *    binary. This is the production path (image comes from GitHub Releases
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
// virtio-fs host share (Mac vfkit): the open project is mounted here so the guest
// reads/writes the user's local disk directly (no SFTP copy, no disk.raw size cap) -
// the "mounted repo" model WSL gets from /mnt. Tag + mount are fixed; the host
// sharedDir varies per launch. Mirrored in isMountedRepo() (common/types.ts).
const VFKIT_SHARE_TAG = 'qoka-data';
const VFKIT_SHARE_MOUNT = '/mnt/qoka';
// Second virtio-fs share: the WHOLE host filesystem (/) mounted read-through at
// /mnt/mac, so ANY local file the user picks - not only files inside the open
// project - is reachable in the guest, matching WSL where the entire drive is at
// /mnt/c. The project keeps its own /mnt/qoka mount for the write-through repo model.
// Mirrored in common/pathMapping.ts (localToRunEnvPath).
const VFKIT_HOST_TAG = 'qoka-host';
const VFKIT_HOST_MOUNT = '/mnt/mac';
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
	// vfkit multi-window: true when THIS window only CONNECTED to a shared VM that
	// another window booted (so stop() must not kill it). false when this window is
	// the owner that booted the VM (or on WSL/QEMU, which are single-owner anyway).
	private vfkitJoined = false;
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

	/** Windows: is the WSL built-in environment already set up (engine + a registered
	 *  Ubuntu + a created account)? A quick, INSTALL-FREE probe. Used to decide whether
	 *  to auto-start for a user who previously skipped setup - we start only when it is
	 *  already usable, and never install/gate them again. Non-Windows returns false
	 *  (skip is Windows-only). */
	async isWslReady(): Promise<boolean> {
		if (process.platform !== 'win32') { return false; }
		try {
			if (!await wslAvailable()) { return false; }
			const distro = pickDistro(await listDistros());
			if (!distro) { return false; }
			const user = await defaultUser(distro);
			return !!user && user !== 'root';
		} catch {
			return false;
		}
	}

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
		// 0 = AUTO: boot at the host's own capacity (all cores; the RAM ceiling
		// hostVmLimits already caps under physical). A positive value is an explicit
		// user cap from set_vm_resources, which we clamp to the host so a config
		// carried from a bigger box can never exceed this machine and crash launch.
		const cpus = vm.cpus > 0 ? Math.min(vm.cpus, lim.maxCpus) : lim.maxCpus;
		const memoryMB = vm.memoryMB > 0 ? Math.min(vm.memoryMB, lim.maxMemoryMB) : lim.maxMemoryMB;
		return {
			cpus: Math.max(1, cpus),
			memoryMB: Math.max(1024, memoryMB),
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

	/** Provision + boot the built-in VM. Windows uses WSL; Apple Silicon uses
	 *  vfkit (Apple VZ - works on every Apple Silicon generation); Intel Mac and
	 *  Linux use portable QEMU. */
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
			try {
				await this.startWsl(progress);
			} catch {
				// A WSL start failure is often a stuck lightweight VM (e.g.
				// `Wsl/Service/E_UNEXPECTED` after an idle timeout). Reset it ONCE with a
				// data-safe `wsl --shutdown` (never --unregister) and retry, so the user
				// never has to touch a terminal.
				progress('The WSL run environment was unresponsive; resetting it and retrying…');
				await wslShutdown();
				try {
					await this.startWsl(progress);
				} catch (second) {
					// The reset did not clear it: a persistent Wsl/Service/…/E_UNEXPECTED
					// means Windows' WSL service itself is wedged, which only a restart of
					// the WSL service (needs admin) or the PC reliably fixes. Surface ONE
					// clear, actionable message - never the misleading "install Ubuntu",
					// since the distro IS present, just unable to start.
					throw this.friendlyWslError(second);
				}
			}
		} else if (process.platform === 'darwin' && process.arch === 'arm64') {
			await this.startVfkit(progress);
		} else {
			await this.startQemu(progress);
		}
	}

	/** Map a persistent WSL start failure to ONE clear, non-technical instruction.
	 *  A wedged WSL service (`Wsl/Service/…/E_UNEXPECTED`) is a Windows-side problem a
	 *  `wsl --shutdown` could not clear, so the honest fix is a restart - say so
	 *  plainly and reassure that nothing is lost. Any other error keeps its message. */
	private friendlyWslError(e: unknown): Error {
		if (isWslServiceError(e)) {
			return new Error(
				'Windows\' WSL service is stuck, and an automatic reset did not clear it. '
				+ 'Please save your work and restart your PC, then reopen Qoka. '
				+ 'Your files and installed tools are safe (nothing is deleted).');
		}
		return e instanceof Error ? e : new Error(String(e));
	}

	/** After opening the Ubuntu OOBE window, wait for the user to create their
	 *  account (the distro's default user flips from `root` to a real name). Polls
	 *  until it appears, so the server start can continue automatically the moment
	 *  the account exists - no manual "Set up now" retry. Rejects after a generous
	 *  timeout so a user who never finishes isn't left waiting forever. */
	private async waitForUbuntuAccount(distro: string): Promise<string> {
		const deadline = Date.now() + 15 * 60_000; // 15 minutes
		while (Date.now() < deadline) {
			await new Promise(r => setTimeout(r, 3000));
			let u: string | undefined;
			try { u = await defaultUser(distro); } catch { continue; }
			if (u && u !== 'root') { return u; }
		}
		throw new Error('Still waiting for the Ubuntu account. Create your username and password in the Ubuntu window, then click "Set up now".');
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
			// The installer enables the WSL engine but it only activates after a reboot,
			// so "not available" here almost always means "installed, needs a restart".
			throw new Error('WSL is not ready yet. If you just installed Qoka, restart your PC to finish enabling WSL, then reopen Qoka. (To install WSL manually: run "wsl --install" in an admin terminal, then reboot.)');
		}

		// listDistrosStrict THROWS if `wsl --list` itself errors (a wedged service),
		// so that case propagates to startReal's shutdown+retry instead of being
		// misread as "no Ubuntu -> install it".
		let distro = pickDistro(await listDistrosStrict());
		if (!distro) {
			// The WSL engine is present (wslAvailable passed) but no Ubuntu distro is
			// registered. This is the state a FRESH machine lands in after the
			// installer enabled the engine and the user rebooted: the engine's install
			// needed a reboot before any WSL2 distro could be registered, so the Ubuntu
			// install falls to HERE, on the first Qoka launch. Do it now (per-user, no
			// elevation needed) instead of dead-ending on an error, then re-detect.
			this.set('provisioning');
			progress('Installing Ubuntu for the built-in run environment (one-time; this can take a few minutes)…');
			try {
				await installUbuntuDistro();
			} catch (e) {
				throw new Error(`Could not install Ubuntu for the built-in run environment: ${e instanceof Error ? e.message : String(e)}. Check your internet connection, or run "wsl --install -d Ubuntu" in a terminal, then try again.`);
			}
			distro = pickDistro(await listDistrosStrict());
			if (!distro) {
				throw new Error('Ubuntu was installed but is not registered yet. Open "Ubuntu" from the Start menu once, then click "Set up now" again.');
			}
		}

		// Ubuntu's first-run account step sets a non-root default user. Until the
		// user has completed it, the default user is root. Open the OOBE window and
		// WAIT for them to create the account, then continue automatically - the
		// account creation is the trigger that advances us to actually starting the
		// server. (No throw + manual "Set up now" retry: if the account already
		// exists this whole branch is skipped and we boot straight away.)
		let user = await defaultUser(distro);
		if (!user || user === 'root') {
			await launchDistroTerminal(distro);
			this.set('provisioning');
			progress('Create your Ubuntu username and password in the window that just opened - setup will continue automatically…');
			user = await this.waitForUbuntuAccount(distro);
		}

		// WSL + Ubuntu + account are all confirmed now → start the server.
		this.set('booting');
		progress('Setting up the WSL run environment…');

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
			// The project folder itself is the mounted repo: workspacePathsFor maps a
			// mounted repo to the unified data/analysis/results layout, so the guest
			// writes pipeline code into analysis/ and outputs into results/ directly.
			repo = windowsToWsl(wsRoot);
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

	/** Intel Mac / Linux boot path: portable QEMU with HVF/KVM and a TCG fallback.
	 *  (Windows uses WSL; Apple Silicon uses vfkit.) */
	private async startQemu(progress: ProgressFn): Promise<void> {
		const qemu = await this.provisioner.ensureQemu(progress);
		const image = await this.provisioner.ensureImage(progress);

		this.set('booting');
		const key = await this.ensureKey();
		const port = await this.freePort();
		const overlay = path.join(this.dir, 'overlay.qcow2');
		const seed = await this.buildSeed(key + '.pub');
		const qimg = this.qemuImg(qemu);

		// A fresh overlay each boot keeps the base image pristine because user DATA
		// lives on the 9p-shared host workspace, not the overlay.
		const createArgs = ['create', '-f', 'qcow2', '-F', 'qcow2', '-b', image, overlay, `${this.config.get().local_vm.diskGB}G`];
		if (fs.existsSync(overlay)) { fs.rmSync(overlay); }
		await execFileAsync(qimg, createArgs, { windowsHide: true });

		const vm = this.hostSafeSpec();
		// Boot with hardware acceleration first, but fall back to (slow) TCG
		// software emulation if qemu exits before SSH comes up. That covers a
		// broken host accelerator such as the QEMU HVF/SME assertion crash seen on
		// some Intel Macs - the VM still boots, just slower.
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
		// virtio-fs host share: mount the OPEN project into the guest so it reads and
		// writes on the Mac's local disk directly (no SFTP copy, no disk.raw size cap).
		// The guest user's uid is set to the Mac user's so shared files are owned by
		// the same uid on both sides - no read/write permission block. Falls back to
		// the guest's own disk when no folder is open.
		const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		const share = wsRoot ? {
			hostDir: wsRoot,
			mount: VFKIT_SHARE_MOUNT,
			tag: VFKIT_SHARE_TAG,
			uid: typeof process.getuid === 'function' ? process.getuid() : 501,
		} : undefined;
		if (share) { ensureWorkspaceScaffold(share.hostDir); }
		// Route the repo through the WHOLE-host mount (/mnt/mac + the project's
		// absolute path), NOT the single-project /mnt/qoka share. /mnt/qoka can only
		// ever point at ONE window's project (the VM is shared), so every window would
		// otherwise resolve to the same project. /mnt/mac is per-window because wsRoot
		// differs per window - mirroring WSL's /mnt/<drive>/<wsRoot>. Falls back to the
		// guest's own dir when no folder is open.
		const repo = wsRoot ? `${VFKIT_HOST_MOUNT}${wsRoot}` : GUEST_REPO;

		// MULTI-WINDOW: if another window already booted the shared vfkit VM, CONNECT
		// to it rather than booting a second VM on the same disk.raw (that corrupts
		// it). Each window still routes results to its OWN project via /mnt/mac/<wsRoot>.
		const running = this.readVfkitOwner();
		if (running && await this.vfkitReachable(running.port) && await this.joinVfkit(running.port, key, repo)) {
			return;
		}
		// Become the owner. Serialize concurrent first-boots with an atomic lock so two
		// windows starting at once don't both boot. If another window is booting, wait
		// for its VM and join; only boot ourselves if that fails.
		if (!this.acquireVfkitBootLock()) {
			if (await this.joinBootingVfkit(key, repo)) { return; }
			this.acquireVfkitBootLock();
		}
		this.vfkitJoined = false;

		const seed = await this.buildVfkitSeed(key + '.pub', share);
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
		const sshProfile = this.profileFor('127.0.0.1', port, GUEST_USER, key, repo);

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
			// Share the open project into the guest (mounted at VFKIT_SHARE_MOUNT by the
			// cloud-init seed) so data lives on the Mac disk, not copied into disk.raw.
			...(share ? ['--device', `virtio-fs,sharedDir=${share.hostDir},mountTag=${share.tag}`] : []),
			// Also share the WHOLE host fs (/) at /mnt/mac so any local file the user
			// picks is reachable, like WSL's /mnt/c. Always present, even with no folder.
			'--device', `virtio-fs,sharedDir=/,mountTag=${VFKIT_HOST_TAG}`,
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
			// Record ownership so later windows CONNECT to this VM instead of booting.
			this.writeVfkitOwner(port);
			this.config.setLocalVmEndpoint(sshProfile);
			this.set('ready');
		} catch (err) {
			try { this.proc?.kill('SIGKILL'); } catch { /* ignore */ }
			try { this.gvproxyProc?.kill('SIGKILL'); } catch { /* ignore */ }
			this.proc = undefined; this.gvproxyProc = undefined;
			throw err instanceof Error ? err : new Error(String(err));
		} finally {
			this.releaseVfkitBootLock();
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
			// 9p host-workspace share (Intel Mac / Linux qemu).
			'-virtfs', `local,path=${this.workspace},mount_tag=aria,security_model=mapped-xattr,id=aria`,
			'-display', 'none', '-serial', `file:${path.join(this.dir, 'console.log')}`,
		];
	}

	// --- vfkit multi-window owner.lock (Mac) ---------------------------------
	// One shared vfkit VM across all windows: the FIRST window boots it (owner) and
	// records its SSH port in vfkit-owner.json; later windows just CONNECT to that
	// port. The VM is the owner's child process, so when the owner window closes the
	// VM dies - a surviving window then finds the marker unreachable on its next run
	// and re-boots, becoming the new owner. So the VM lives as long as any window
	// uses it, with no detached/orphan process ever. A short atomic boot lock keeps
	// two windows starting at once from booting two VMs on the same disk.

	private get vfkitOwnerFile(): string { return path.join(this.dir, 'vfkit-owner.json'); }
	private get vfkitBootLockDir(): string { return path.join(this.dir, 'vfkit-boot.lock'); }

	private readVfkitOwner(): { port: number } | undefined {
		try {
			const o = JSON.parse(fs.readFileSync(this.vfkitOwnerFile, 'utf8')) as { port?: unknown };
			return typeof o.port === 'number' ? { port: o.port } : undefined;
		} catch { return undefined; }
	}
	private writeVfkitOwner(port: number): void {
		try { fs.writeFileSync(this.vfkitOwnerFile, JSON.stringify({ port, pid: process.pid, at: Date.now() })); } catch { /* best-effort */ }
	}
	private removeVfkitOwner(): void { try { fs.rmSync(this.vfkitOwnerFile, { force: true }); } catch { /* ignore */ } }

	/** Quick TCP probe of the shared VM's forwarded SSH port - a dead owner (its
	 *  vfkit + gvproxy died with it) means the port refuses, so we know to re-boot. */
	private vfkitReachable(port: number, timeoutMs = 1500): Promise<boolean> {
		return new Promise(resolve => {
			const sock = net.connect({ host: '127.0.0.1', port });
			const done = (ok: boolean): void => { try { sock.destroy(); } catch { /* ignore */ } resolve(ok); };
			sock.setTimeout(timeoutMs);
			sock.once('connect', () => done(true));
			sock.once('timeout', () => done(false));
			sock.once('error', () => done(false));
		});
	}

	/** Atomically claim the right to boot (mkdir throws if it exists). Steals a lock
	 *  older than 90s (a window that crashed mid-boot). Returns true if we hold it. */
	private acquireVfkitBootLock(): boolean {
		try {
			try {
				const st = fs.statSync(this.vfkitBootLockDir);
				if (Date.now() - st.mtimeMs > 90_000) { fs.rmSync(this.vfkitBootLockDir, { recursive: true, force: true }); }
			} catch { /* no lock yet */ }
			fs.mkdirSync(this.vfkitBootLockDir);
			return true;
		} catch { return false; }
	}
	private releaseVfkitBootLock(): void { try { fs.rmSync(this.vfkitBootLockDir, { recursive: true, force: true }); } catch { /* ignore */ } }

	/** Connect to an already-running shared vfkit VM at `port` as a non-owner. */
	private async joinVfkit(port: number, key: string, repo: string): Promise<boolean> {
		const sshProfile = this.profileFor('127.0.0.1', port, GUEST_USER, key, repo);
		try {
			await this.waitForSsh(sshProfile);
			this.vfkitJoined = true;
			this.config.setLocalVmEndpoint(sshProfile);
			this.set('ready');
			return true;
		} catch { return false; }
	}

	/** Another window holds the boot lock: poll for its owner marker + reachable port
	 *  and join it. Returns false (so the caller boots itself) if the booter gives up
	 *  or does not come up in time. */
	private async joinBootingVfkit(key: string, repo: string): Promise<boolean> {
		const deadline = Date.now() + 60_000;
		while (Date.now() < deadline) {
			const owner = this.readVfkitOwner();
			if (owner && await this.vfkitReachable(owner.port)) {
				if (await this.joinVfkit(owner.port, key, repo)) { return true; }
			}
			// If the boot lock is free again but still no reachable owner, the booter
			// gave up - boot ourselves.
			if (this.acquireVfkitBootLock()) { this.releaseVfkitBootLock(); if (!this.readVfkitOwner()) { return false; } }
			await new Promise(r => setTimeout(r, 1000));
		}
		return false;
	}

	async stop(): Promise<void> {
		this.set('stopped');
		this.config.setLocalVmEndpoint(null);
		if (this.vfkitJoined) {
			// We only CONNECTED to another window's shared VM - never kill it. Drop our
			// reference; the owning window manages the VM's lifetime.
			this.vfkitJoined = false;
			this.proc = undefined;
			this.gvproxyProc = undefined;
			return;
		}
		// We own the VM (or it is WSL/QEMU). Remove the vfkit owner marker so a
		// surviving window re-boots and takes over (no-op file for WSL/QEMU).
		this.removeVfkitOwner();
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

	/** Recover a degraded built-in run environment WITHOUT losing data, then start
	 *  fresh. On Windows a read-only / stuck WSL distro only clears when the
	 *  lightweight VM is killed: stop our keeper, `wsl --shutdown` (data-safe - never
	 *  --unregister), then start. Used when a run fails with a degraded-WSL signature,
	 *  so the fix a manual `wsl --shutdown` gives happens automatically, no terminal. */
	async recover(): Promise<void> {
		await this.stop();
		if (process.platform === 'win32') {
			await wslShutdown();
		}
		await this.start();
	}

	dispose(): void { void this.stop(); this._onDidChange.dispose(); this._onProgress.dispose(); }

	// --- helpers ------------------------------------------------------------

	private profileFor(host: string, port: number, username: string, keyPath: string, repo: string): SshProfile {
		return { id: LOCAL_VM_ID, name: 'Qoka built-in', host, port, username, auth: { type: 'key', key_path: keyPath }, repo_path: repo };
	}

	private qemuImg(qemu: string): string {
		const cand = path.join(path.dirname(qemu), 'qemu-img');
		return fs.existsSync(cand) ? cand : 'qemu-img';
	}

	private accel(): string {
		switch (process.platform) {
			case 'darwin': return 'hvf';
			default: return 'kvm';
		}
	}

	/** `-machine`/`-accel`/`-cpu` args for a specific accelerator.
	 *  - hvf/kvm: `-cpu host` (host passthrough - required and fast).
	 *  - tcg: `-cpu max` (host is invalid under software emulation). */
	private cpuMachineArgs(accel: string): string[] {
		const machine = this.machineType();
		if (accel === 'tcg') {
			return ['-machine', machine, '-accel', 'tcg', '-cpu', 'max'];
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
	private async buildVfkitSeed(pubPath: string, share?: { hostDir: string; mount: string; tag: string; uid: number }): Promise<string> {
		const dir = path.join(this.dir, 'seed-src');
		fs.mkdirSync(dir, { recursive: true });
		const pub = fs.readFileSync(pubPath, 'utf8').trim();
		// Bump the instance-id whenever runcmd changes: cloud-init runs runcmd only on a
		// NEW instance-id, so existing disk.raw users would otherwise never get the
		// virtio-fs mount / uid fix. Everything in runcmd is idempotent.
		fs.writeFileSync(path.join(dir, 'meta-data'), 'instance-id: aria-builtin-vfs3\nlocal-hostname: aria\n');
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
		const userLines = [
			`  - name: ${GUEST_USER}`,
			'    groups: [sudo]',
			'    sudo: ALL=(ALL) NOPASSWD:ALL',
			'    shell: /bin/bash',
			'    ssh_authorized_keys:',
			`      - ${pub}`,
		];
		const runcmd = [
			// Docker is baked into the image; this is an idempotent fallback only.
			'  - command -v docker >/dev/null 2>&1 || (curl -fsSL https://get.docker.com | sh)',
			`  - usermod -aG docker ${GUEST_USER} || true`,
			// Mount the WHOLE host fs at /mnt/mac so ANY local file is reachable (like
			// WSL's /mnt/c). Persisted in fstab (nofail) to re-mount every boot.
			`  - mkdir -p ${VFKIT_HOST_MOUNT}`,
			`  - grep -q ' ${VFKIT_HOST_MOUNT} virtiofs' /etc/fstab || echo '${VFKIT_HOST_TAG} ${VFKIT_HOST_MOUNT} virtiofs defaults,nofail 0 0' >> /etc/fstab`,
			`  - mount -t virtiofs ${VFKIT_HOST_TAG} ${VFKIT_HOST_MOUNT} 2>/dev/null || mount ${VFKIT_HOST_MOUNT} 2>/dev/null || true`,
		];
		if (share) {
			// Mount the virtio-fs share now AND persist it in fstab (nofail) so it
			// re-mounts on every boot. Guest reads world-readable host files; new files
			// it writes are owned by the guest uid on the host but stay accessible.
			// (The uid-matching a prior version did is GONE - it broke sshd auth; see
			// the bootcmd corrective below.)
			runcmd.push(`  - mkdir -p ${share.mount}`);
			runcmd.push(`  - grep -q ' ${share.mount} virtiofs' /etc/fstab || echo '${share.tag} ${share.mount} virtiofs defaults,nofail 0 0' >> /etc/fstab`);
			runcmd.push(`  - mount -t virtiofs ${share.tag} ${share.mount} 2>/dev/null || mount ${share.mount} 2>/dev/null || true`);
		}
		fs.writeFileSync(path.join(dir, 'user-data'), [
			'#cloud-config',
			'users:',
			...userLines,
			'ssh_pwauth: false',
			// bootcmd runs EARLY on EVERY boot (before sshd) - repair any home-ownership
			// damage a prior build left (chown home back to aria by NAME) so sshd key auth
			// holds and the VM actually connects, instead of being restarted mid-boot.
			'bootcmd:',
			`  - chown -R ${GUEST_USER}:${GUEST_USER} /home/${GUEST_USER} 2>/dev/null || true`,
			'runcmd:',
			...runcmd,
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
