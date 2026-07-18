/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { spawn, ChildProcess } from 'child_process';
import * as net from 'net';
import * as crypto from 'crypto';
import { Client } from 'ssh2';
import { SshEndpoint } from './rehConnect';

/**
 * Shares the host project folder into the VM at /home/aria/project via
 * `rclone serve sftp` (host) + `sshfs` (guest) — the exact path validated in the
 * file-share test:
 *   - rclone binds 127.0.0.1:<port> on the host;
 *   - the guest reaches it as <gateway>:<port>, which the VM's user-mode network
 *     maps back to the host loopback (qemu slirp gateway 10.0.2.2; vfkit/gvproxy
 *     gateway 192.168.127.1).
 *
 * Design rule (measured): only the project SOURCE/DOCS live here — small-file
 * ops over sshfs are ~128x slower than guest-local, so heavy build output
 * (node_modules, venv, docker layers) must stay on the guest disk, OUTSIDE this
 * mount. That policy is enforced by the tools that create such output, not here.
 *
 * `rclone serve nfs` does NOT exist on the Windows rclone build — sftp is the
 * portable choice across Windows/macOS/Linux.
 */

const GUEST_MOUNT = '/home/aria/project';

export interface ShareSession {
	dispose(): void;
}

/** Guest-visible host gateway. Override with ARIA_SHARE_GATEWAY for manual VMs. */
export function hostGatewayForGuest(): string {
	if (process.env.ARIA_SHARE_GATEWAY) {
		return process.env.ARIA_SHARE_GATEWAY;
	}
	return (process.platform === 'darwin' && process.arch === 'arm64') ? '192.168.127.1' : '10.0.2.2';
}

export async function startFileShare(
	opts: { hostFolder: string; ssh: SshEndpoint; rclonePath: string },
	log: (line: string) => void,
): Promise<ShareSession> {
	const { hostFolder, ssh, rclonePath } = opts;
	const gateway = hostGatewayForGuest();
	const port = await freePort();
	const password = crypto.randomBytes(18).toString('hex');

	// 1) Host: rclone serve sftp on the loopback. 127.0.0.1 is enough — the guest
	//    reaches it through the gateway mapping.
	const args = ['serve', 'sftp', hostFolder, '--addr', `127.0.0.1:${port}`, '--user', 'aria', '--pass', password];
	const proc: ChildProcess = spawn(rclonePath, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
	proc.stderr?.on('data', (d: Buffer) => log(`[rclone] ${d.toString()}`));
	await waitForPort(port, 10_000);
	log(`[aria-remote] rclone sftp serving ${hostFolder} on 127.0.0.1:${port}`);

	// 2) Guest: sshfs-mount the share at GUEST_MOUNT. password_stdin keeps the
	//    secret off the argv; reconnect survives brief drops.
	const conn = await sshConnect(ssh);
	const mountCmd =
		`mkdir -p ${GUEST_MOUNT} && echo '${password}' | ` +
		`sshfs -o password_stdin,StrictHostKeyChecking=no,UserKnownHostsFile=/dev/null,` +
		`port=${port},reconnect aria@${gateway}:/ ${GUEST_MOUNT}`;
	await sshExec(conn, mountCmd);
	log(`[aria-remote] guest sshfs mounted host folder at ${GUEST_MOUNT}`);

	return {
		dispose: () => {
			// Unmount in the guest (best-effort) then stop rclone.
			sshExec(conn, `fusermount3 -u ${GUEST_MOUNT} 2>/dev/null || fusermount -u ${GUEST_MOUNT} 2>/dev/null || true`)
				.catch(() => { /* ignore */ })
				.finally(() => { try { conn.end(); } catch { /* ignore */ } });
			try { proc.kill(); } catch { /* ignore */ }
		},
	};
}

// --- helpers ----------------------------------------------------------------

function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const srv = net.createServer();
		srv.listen(0, '127.0.0.1', () => {
			const p = (srv.address() as net.AddressInfo).port;
			srv.close(() => resolve(p));
		});
		srv.on('error', reject);
	});
}

function waitForPort(port: number, timeoutMs: number): Promise<void> {
	return new Promise((resolve, reject) => {
		const deadline = Date.now() + timeoutMs;
		const tryOnce = () => {
			const sock = net.connect(port, '127.0.0.1');
			sock.on('connect', () => { sock.destroy(); resolve(); });
			sock.on('error', () => {
				sock.destroy();
				if (Date.now() > deadline) { reject(new Error(`rclone did not listen on ${port} in time.`)); }
				else { setTimeout(tryOnce, 250); }
			});
		};
		tryOnce();
	});
}

function sshConnect(ep: SshEndpoint): Promise<Client> {
	return new Promise((resolve, reject) => {
		const conn = new Client();
		conn.on('ready', () => resolve(conn));
		conn.on('error', reject);
		conn.connect({
			host: ep.host, port: ep.port, username: ep.username,
			privateKey: ep.privateKey, password: ep.password,
			readyTimeout: 20_000, keepaliveInterval: 20_000,
		});
	});
}

function sshExec(conn: Client, command: string): Promise<void> {
	return new Promise((resolve, reject) => {
		conn.exec(command, (err, stream) => {
			if (err) { reject(err); return; }
			let stderr = '';
			stream.on('close', (code: number | null) => {
				if (code === 0 || code === null) { resolve(); }
				else { reject(new Error(`guest command failed (exit ${code}): ${stderr.trim()}`)); }
			});
			stream.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
			stream.on('data', () => { /* drain stdout */ });
		});
	});
}
