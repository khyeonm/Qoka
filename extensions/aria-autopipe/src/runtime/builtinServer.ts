/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { services } from '../common/services';
import { SshProfile } from '../common/types';
import { SshResult, RunOptions } from '../ssh/sshService';

/**
 * Thin accessor for the Qoka built-in server (the WSL distro on Windows, or the
 * QEMU/vfkit VM on Mac/Linux) as a SHARED runtime. VMManager owns the built-in
 * server's lifecycle; any MCP - autopipe or qoka-run - reaches it through here
 * instead of reassembling `config.activeProfile() + ssh.run` itself.
 *
 * The built-in server is a single-owner resource (one distro/VM, one sshd, one
 * dockerd), so this NEVER starts a second one: `ensureBuiltinServer` just calls
 * the idempotent `VMManager.start()` and returns the endpoint VMManager
 * registered. run_code always targets the built-in server (not the active SSH
 * profile), because its whole value is a local, always-available scratch runtime.
 */

/** Boot the built-in server if it isn't up (idempotent) and return its live SSH
 *  endpoint. Throws if it never becomes ready. */
export async function ensureBuiltinServer(): Promise<SshProfile> {
	const { vm, config } = services();
	await vm.start();
	const ep = config.localVmProfile();
	if (!ep) {
		throw new Error('The built-in server did not become ready.');
	}
	return ep;
}

/** Convenience: ensure the built-in server is up, then run one command on it. */
export async function builtinExec(command: string, opts?: RunOptions): Promise<SshResult> {
	const { ssh } = services();
	const ep = await ensureBuiltinServer();
	return ssh.run(ep, command, opts);
}

/**
 * The run target for run_code, honoring the ACTIVE connection chosen in the
 * Connections tab: the built-in server when it is the active target, otherwise
 * the active SSH profile. `isBuiltIn` lets the caller decide whether the local
 * /mnt mount is available (built-in on Windows/WSL) or results must be
 * SFTP-copied back (a remote SSH host). Throws when nothing is selected.
 */
export async function resolveRunTarget(): Promise<{ profile: SshProfile; isBuiltIn: boolean }> {
	const { config } = services();
	if (config.isLocalVmActive()) {
		return { profile: await ensureBuiltinServer(), isBuiltIn: true };
	}
	const profile = config.activeProfile();
	if (!profile) {
		throw new Error('No active connection. Open the Connections tab and select the built-in server or an SSH server.');
	}
	return { profile, isBuiltIn: false };
}
