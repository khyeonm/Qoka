/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Client, ConnectConfig } from 'ssh2';
import * as net from 'net';
import * as crypto from 'crypto';

/**
 * The SSH-based half of the aria-vm resolver. This is the exact analogue of
 * vscode-test-resolver's `cp.spawn(serverCommand, …)` + "Extension host agent
 * listening on <port>" parsing, except the REH runs INSIDE the VM over SSH and
 * we forward its guest-local port back to a host-local port.
 *
 * Flow:
 *   1. SSH into the VM.
 *   2. Run the baked-in REH: `aria-reh --host=127.0.0.1 --port=0 …`. It prints
 *      the port it bound on stdout.
 *   3. Open a host-local TCP server and forward every connection to the guest's
 *      127.0.0.1:<rehPort> over the SAME ssh connection (a classic `ssh -L`).
 *   4. Hand the host-local port back; the resolver returns it as the
 *      ResolvedAuthority the renderer connects to.
 *
 * The REH stays alive as long as the exec stream (and thus the ssh connection)
 * is open, so we keep `conn` until dispose().
 */

export interface SshEndpoint {
	host: string;
	port: number;
	username: string;
	/** PEM private key bytes (key auth) — preferred for the built-in VM. */
	privateKey?: Buffer;
	/** Password (password auth) — used for user-supplied external hosts. */
	password?: string;
}

export interface RehConnection {
	/** Host-local port the renderer connects to (forwarded to the guest REH). */
	localPort: number;
	/** Shared secret the renderer must present; passed to both the REH and the
	 *  ResolvedAuthority so the two agree. */
	connectionToken: string;
	dispose(): void;
}

/** Absolute path to the baked-in REH launcher inside the guest (see
 *  vm-image.yml: the `vscode-reh-linux-<arch>` tree is placed at /opt/aria-reh
 *  and symlinked to /usr/local/bin/aria-reh). */
const GUEST_REH_BIN = '/usr/local/bin/aria-reh';

const REH_READY_RE = /Extension host agent listening on (\d+)/;
const REH_START_TIMEOUT_MS = 60_000;

function connectConfig(ep: SshEndpoint): ConnectConfig {
	const cfg: ConnectConfig = {
		host: ep.host,
		port: ep.port,
		username: ep.username,
		readyTimeout: 30_000,
		keepaliveInterval: 20_000,
	};
	if (ep.privateKey) {
		cfg.privateKey = ep.privateKey;
	} else if (ep.password) {
		cfg.password = ep.password;
	} else {
		throw new Error('aria-remote: SSH endpoint has neither a private key nor a password.');
	}
	return cfg;
}

/** Open an ssh connection to the VM, launch the REH, and forward its port. */
export function startRehAndForward(ep: SshEndpoint, log: (line: string) => void): Promise<RehConnection> {
	return new Promise<RehConnection>((resolve, reject) => {
		const connectionToken = String(crypto.randomInt(0xffffffffff));
		// Per-session data dir inside the guest keeps concurrent windows from
		// clobbering each other's server state.
		const dataDir = `/home/${ep.username}/.aria-reh/${connectionToken}`;

		const conn = new Client();
		let settled = false;
		let localServer: net.Server | undefined;

		const fail = (err: Error) => {
			if (settled) { return; }
			settled = true;
			try { localServer?.close(); } catch { /* ignore */ }
			try { conn.end(); } catch { /* ignore */ }
			reject(err);
		};

		const startTimer = setTimeout(
			() => fail(new Error(`aria-remote: REH did not report a port within ${REH_START_TIMEOUT_MS}ms.`)),
			REH_START_TIMEOUT_MS,
		);

		conn.on('error', (err) => fail(err instanceof Error ? err : new Error(String(err))));

		conn.on('ready', () => {
			// `exec` (not a login shell) keeps the process tied to this channel:
			// closing the channel / connection tears the REH down, so there is no
			// orphaned server when the window closes.
			const cmd =
				`${GUEST_REH_BIN} --host=127.0.0.1 --port=0` +
				` --connection-token ${connectionToken}` +
				` --server-data-dir ${dataDir}` +
				` --disable-telemetry --accept-server-license-terms`;
			log(`[aria-remote] exec: ${cmd}`);
			conn.exec(cmd, (err, stream) => {
				if (err) { fail(err); return; }
				let buf = '';
				stream.on('data', (d: Buffer) => {
					const text = d.toString();
					log(text);
					buf += text;
					const m = buf.match(REH_READY_RE);
					if (m && !settled) {
						const rehPort = parseInt(m[1], 10);
						clearTimeout(startTimer);
						openForward(rehPort);
					}
				});
				stream.stderr.on('data', (d: Buffer) => log(`[reh stderr] ${d.toString()}`));
				stream.on('close', (code: number | null) => {
					// If the REH dies before we've resolved, surface it; after
					// resolve the window's own connection loss handles it.
					if (!settled) {
						fail(new Error(`aria-remote: REH exited before it was ready (code ${code}). See the Remote (VM) log.`));
					}
				});
			});
		});

		// Host-local listener → forward each connection to the guest REH over the
		// same ssh connection (ssh -L semantics).
		const openForward = (rehPort: number) => {
			const server = net.createServer((sock) => {
				conn.forwardOut('127.0.0.1', 0, '127.0.0.1', rehPort, (err, stream) => {
					if (err) { log(`[aria-remote] forwardOut failed: ${err.message}`); sock.destroy(); return; }
					sock.pipe(stream);
					stream.pipe(sock);
					const drop = () => { try { sock.destroy(); } catch { /* ignore */ } try { stream.destroy(); } catch { /* ignore */ } };
					sock.on('error', drop);
					stream.on('error', drop);
				});
			});
			localServer = server;
			server.on('error', (err) => fail(err));
			server.listen(0, '127.0.0.1', () => {
				const addr = server.address() as net.AddressInfo;
				settled = true;
				log(`[aria-remote] REH ready on guest ${rehPort}; forwarded to host 127.0.0.1:${addr.port}`);
				resolve({
					localPort: addr.port,
					connectionToken,
					dispose: () => {
						try { server.close(); } catch { /* ignore */ }
						try { conn.end(); } catch { /* ignore */ }
					},
				});
			});
		};

		try {
			conn.connect(connectConfig(ep));
		} catch (e) {
			fail(e instanceof Error ? e : new Error(String(e)));
		}
	});
}
