/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * WSL backend helpers for the Windows built-in Run environment.
 *
 * On Windows, Qoka's "built-in" run target is a WSL2 Ubuntu distro instead of a
 * QEMU VM. Because the whole autopipe stack only ever talks to an `SshProfile`
 * (short-lived ssh2 connections for exec + SFTP), we provision the distro with
 * `openssh-server` + `docker`, start sshd on a forwarded port, and hand the
 * VMManager a synthetic `SshProfile` pointing at `127.0.0.1:<port>`. WSL2's
 * localhost forwarding makes the distro's sshd reachable from Windows with no
 * resolver/REH machinery.
 *
 * All provisioning runs as root inside the distro (`wsl -u root`), so no sudo
 * password is needed, and every step is idempotent so it converges on repeated
 * launches (WSL shuts distros down when idle; each Qoka start re-establishes
 * sshd + dockerd).
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import { join } from 'path';

const execFileAsync = promisify(execFile);

/** Longer than a normal exec: a first-run `apt-get install docker.io` pulls a
 *  lot and can take minutes on a slow connection. */
const PROVISION_TIMEOUT_MS = 600_000;

/** Absolute path to wsl.exe, resolved the same way vs/platform/remote/node/wsl.ts
 *  does (honouring the SysWOW64 redirection edge case). Falls back to the bare
 *  name so a PATH-resolved wsl.exe still works. */
export function wslExePath(): string {
	const systemRoot = process.env['SystemRoot'];
	if (systemRoot) {
		const is32on64 = Object.prototype.hasOwnProperty.call(process.env, 'PROCESSOR_ARCHITEW6432');
		return join(systemRoot, is32on64 ? 'Sysnative' : 'System32', 'wsl.exe');
	}
	return 'wsl.exe';
}

// wsl.exe prints its OWN output (--status, --list) as UTF-16LE. Forcing WSL_UTF8
// makes newer builds emit UTF-8; we still defensively strip NULs for older ones.
const WSL_ENV = { ...process.env, WSL_UTF8: '1' };

/** wsl.exe UTF-16 output read as a JS string carries interleaved U+0000s; drop
 *  them (and CRs) so line parsing works. A no-op once WSL_UTF8 gives clean UTF-8. */
function stripNuls(s: string): string {
	return s.split('\u0000').join('').split('\r').join('');
}

/** True when the WSL feature is present and responsive (`wsl --status` exits 0). */
export async function wslAvailable(): Promise<boolean> {
	try {
		await execFileAsync(wslExePath(), ['--status'], { windowsHide: true, env: WSL_ENV, timeout: 15_000 });
		return true;
	} catch {
		return false;
	}
}

/** Installed distro names (excludes docker-desktop's helper distros). */
export async function listDistros(): Promise<string[]> {
	try {
		const { stdout } = await execFileAsync(wslExePath(), ['--list', '--quiet'], { windowsHide: true, env: WSL_ENV, timeout: 15_000 });
		return stripNuls(stdout)
			.split('\n')
			.map(l => l.trim())
			.filter(Boolean)
			.filter(name => !/^docker-desktop/i.test(name));
	} catch {
		return [];
	}
}

/** Pick the distro Qoka should run in: prefer an Ubuntu, else the first real
 *  distro. Returns undefined when none is installed (needs `wsl --install`). */
export function pickDistro(distros: string[]): string | undefined {
	return distros.find(d => /^ubuntu/i.test(d)) ?? distros[0];
}

/** The distro's default login user (set by Ubuntu's first-run account step).
 *  Returns 'root' when the OOBE account has not been created yet. */
export async function defaultUser(distro: string): Promise<string> {
	const { stdout } = await execFileAsync(
		wslExePath(), ['-d', distro, '--', 'sh', '-c', 'id -un'],
		{ windowsHide: true, env: WSL_ENV, timeout: 15_000 },
	);
	return stripNuls(stdout).trim();
}

/** Run a script inside the distro as root (no sudo password needed). */
export async function runAsRoot(distro: string, script: string): Promise<string> {
	const { stdout } = await execFileAsync(
		wslExePath(), ['-d', distro, '-u', 'root', '--', 'bash', '-lc', script],
		{ windowsHide: true, env: WSL_ENV, timeout: PROVISION_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 },
	);
	return stripNuls(stdout);
}

/** Open an interactive WSL terminal so the user can complete the distro's
 *  first-run account creation. Best-effort; never throws. */
export async function launchDistroTerminal(distro: string): Promise<void> {
	try {
		// `start` returns immediately, opening the distro in a new console window.
		await execFileAsync('cmd.exe', ['/c', 'start', '', 'wsl.exe', '-d', distro], { windowsHide: true, timeout: 10_000 });
	} catch {
		/* best-effort */
	}
}

/**
 * The idempotent provisioning script. Installs openssh-server + docker if
 * missing, injects Qoka's SSH public key for `user`, points sshd at `port`, and
 * (re)starts sshd + dockerd without systemd (`service ...`), so it works on a
 * stock WSL2 distro with no `[boot] systemd=true`. Prints QOKA_PROVISION_OK on
 * success. `repoDir` is created and owned by the user.
 */
export function provisionScript(user: string, port: number, pubKey: string, repoDir: string): string {
	// user/port are trusted (whoami / freePort); pubKey is our own ssh-keygen
	// output (single line, no quotes). Still keep the pubKey in single quotes.
	const u = user;
	return [
		'set -e',
		'export DEBIAN_FRONTEND=noninteractive',
		'APT_UPDATED=0',
		'apt_update_once() { if [ "$APT_UPDATED" = 0 ]; then apt-get update -y; APT_UPDATED=1; fi; }',
		// Decide by the REAL artifact, not `command -v`: on a box with Docker
		// Desktop the injected `docker` CLI makes `command -v docker` succeed while
		// openssh-server is still absent, so a `command -v sshd` heuristic wrongly
		// skips the install and the later sed on /etc/ssh/sshd_config fails.
		'if [ ! -f /etc/ssh/sshd_config ]; then apt_update_once; apt-get install -y openssh-server; fi',
		// Install the native docker engine only when NO docker CLI works, leaving a
		// Docker Desktop WSL integration untouched.
		'if ! command -v docker >/dev/null 2>&1; then apt_update_once; apt-get install -y docker.io; fi',
		// docker-in-WSL2 needs the legacy iptables backend on some kernels.
		'update-alternatives --set iptables /usr/sbin/iptables-legacy >/dev/null 2>&1 || true',
		`usermod -aG docker '${u}' 2>/dev/null || true`,
		`install -d -m 700 -o '${u}' -g '${u}' '/home/${u}/.ssh'`,
		`printf '%s\\n' '${pubKey}' > '/home/${u}/.ssh/authorized_keys'`,
		`chown '${u}':'${u}' '/home/${u}/.ssh/authorized_keys'`,
		`chmod 600 '/home/${u}/.ssh/authorized_keys'`,
		`install -d -o '${u}' -g '${u}' '${repoDir}'`,
		// sshd: fixed port + host keys + run dir. Rewrite any existing Port line,
		// then ensure one is present. sshd_config is guaranteed present by now.
		`sed -i 's/^#\\?Port .*/Port ${port}/' /etc/ssh/sshd_config`,
		`grep -q '^Port ${port}$' /etc/ssh/sshd_config || echo 'Port ${port}' >> /etc/ssh/sshd_config`,
		'ssh-keygen -A',
		'mkdir -p /run/sshd',
		'service ssh restart >/dev/null 2>&1 || /usr/sbin/sshd',
		// Start a native dockerd only; Docker Desktop manages its own daemon.
		'if command -v dockerd >/dev/null 2>&1; then service docker start >/dev/null 2>&1 || (dockerd >/tmp/qoka-dockerd.log 2>&1 &); fi',
		'echo QOKA_PROVISION_OK',
	].join('\n');
}
