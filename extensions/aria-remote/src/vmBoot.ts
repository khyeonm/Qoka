/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { SshEndpoint } from './rehConnect';
import { VmLauncher } from './vm/vmLauncher';
import { ProgressFn } from './vm/provisioner';

/**
 * Produces the SSH endpoint of the VM the resolver connects to. Two paths:
 *
 *  (a) DEV/TEST — connect to an ALREADY-running VM given by ARIA_VM_SSH_* env
 *      vars. Boot a qemu VM by hand, then point these at 127.0.0.1:<ssh-port>.
 *      Lets you exercise the REH connection without the full boot path.
 *
 *  (b) PRODUCTION — boot the built-in VM on the host via VmLauncher (qemu+WHPX on
 *      Windows, vfkit on macOS, qemu+KVM on Linux) and return its endpoint. This
 *      lives on the ui (host) side because it spawns qemu/vfkit, which can't run
 *      inside the guest.
 */

export interface VmSession {
	endpoint: SshEndpoint;
	/** Release anything this module owns: no-op for the manual (a) path, stops the
	 *  VM we booted for (b). */
	dispose(): void;
}

export async function ensureVm(
	context: vscode.ExtensionContext,
	progress: ProgressFn,
	log: (line: string) => void,
): Promise<VmSession> {
	const manual = manualEndpoint();
	if (manual) {
		log(`[aria-remote] using ARIA_VM_SSH_* endpoint ${manual.username}@${manual.host}:${manual.port}`);
		return { endpoint: manual, dispose: () => { /* not ours to stop */ } };
	}

	// (b) Boot the built-in VM.
	const dir = path.join(context.globalStorageUri.fsPath, 'vm');
	const launcher = new VmLauncher(dir);
	const vm = await launcher.boot(progress, log);
	return {
		endpoint: {
			host: vm.host,
			port: vm.port,
			username: vm.username,
			privateKey: fs.readFileSync(vm.privateKeyPath),
		},
		dispose: () => { void vm.stop(); },
	};
}

/** Build an endpoint from ARIA_VM_SSH_* env vars, or undefined if unset. */
function manualEndpoint(): SshEndpoint | undefined {
	const host = process.env.ARIA_VM_SSH_HOST;
	const portStr = process.env.ARIA_VM_SSH_PORT;
	if (!host || !portStr) {
		return undefined;
	}
	const port = parseInt(portStr, 10);
	if (!Number.isFinite(port)) {
		throw new Error(`aria-remote: ARIA_VM_SSH_PORT is not a number: ${portStr}`);
	}
	const username = process.env.ARIA_VM_SSH_USER || 'aria';
	const keyPath = process.env.ARIA_VM_SSH_KEY;
	const password = process.env.ARIA_VM_SSH_PASSWORD;
	if (!keyPath && !password) {
		throw new Error('aria-remote: set ARIA_VM_SSH_KEY (path to a private key) or ARIA_VM_SSH_PASSWORD.');
	}
	return {
		host,
		port,
		username,
		privateKey: keyPath ? fs.readFileSync(keyPath) : undefined,
		password,
	};
}
