/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ToolDefinition, textResult } from './types';
import { services } from '../../common/services';
import { hostVmLimits } from '../../common/types';
import { ensureBuiltinServer, isReachable, restartBuiltinServer } from '../../runtime/builtinServer';

// Built-in server (local QEMU VM) resource tools. These ONLY apply when the
// active run environment is the built-in VM - an SSH server's resources are the
// remote machine's and aren't ours to change.

/**
 * Message for when the built-in server can't start / stay reachable. On Windows
 * the built-in server IS a WSL2 distro, so the most common cause is a missing
 * distribution (the WSL engine can be present - `wsl --version` works - while no
 * Ubuntu is installed). Surface a concrete check-and-install path there.
 */
function builtinFailureGuidance(reason: string): string {
	const base = `The built-in server could not be started (${reason}).`;
	if (process.platform === 'win32') {
		return [
			base,
			'',
			'On Windows the built-in server runs on WSL. Ask the user to check, in PowerShell:',
			'  - `wsl --version`  (the WSL engine - note: this succeeds even with NO Linux distribution installed)',
			'  - `wsl -l -v`      (the installed distributions)',
			'If `wsl -l -v` is EMPTY, there is no Linux distribution yet - install one and create an account:',
			'  `wsl --install -d Ubuntu`   then open Ubuntu once to set a username/password.',
			'After a distribution is installed and an account created, call start_server again.',
		].join('\n');
	}
	return `${base} Tell the user, wait ~60-90 seconds, then call start_server again; if it keeps failing, ask them to restart the app.`;
}

export const VM_TOOLS: ToolDefinition[] = [
	{
		name: 'start_server',
		description: '(Re)start and VERIFY the ACTIVE run connection - the built-in server OR the SSH server selected in the Connections tab. Call this whenever code cannot run because the connection is not ready: the built-in server is not running, an SSH server is unreachable, or a run just failed with a connection/refused error. For the built-in server it boots or restarts it and confirms it actually answers over SSH; for an SSH server it re-tests the connection and reports the endpoint. If the built-in server repeatedly fails to start on Windows, it tells you to check that WSL AND a Linux distribution (Ubuntu) are installed. Call this instead of asking the user to press a button. After it reports the connection is up, retry the run.',
		inputSchema: { type: 'object', properties: {} },
		handler: async () => {
			const { config, ssh } = services();

			// SSH server is the active target: don't touch the built-in server -
			// just re-test the connection (ssh2 opens a fresh connection each call,
			// so a probe IS the reconnect) and report the endpoint.
			if (!config.isLocalVmActive()) {
				const profile = config.activeProfile();
				if (!profile) {
					return textResult('No run connection is selected. Open the Connections tab and choose the built-in server or an SSH server, then try again.');
				}
				const ep = `${profile.username}@${profile.host}:${profile.port}`;
				try {
					const ok = await ssh.canConnect(profile, 8000);
					return textResult(ok
						? `The SSH server ${ep} is connected and reachable. Retry the run.`
						: `The SSH server ${ep} is NOT reachable. Ask the user to check that the server is on, the host/port/username are correct, credentials are valid, and the network/VPN is up - then try again.`);
				} catch (e) {
					return textResult(`Could not reach the SSH server ${ep}: ${e instanceof Error ? e.message : String(e)}. Check host/port/credentials and the network, then retry.`);
				}
			}

			// Built-in server is the active target: ensure it is up, and if it does
			// not actually answer, restart it once before giving up.
			try {
				let ok = false;
				try {
					const ep = await ensureBuiltinServer();
					ok = await isReachable(ep);
					if (!ok) {
						const ep2 = await restartBuiltinServer();
						ok = await isReachable(ep2);
					}
				} catch (startErr) {
					return textResult(builtinFailureGuidance(startErr instanceof Error ? startErr.message : String(startErr)));
				}
				return ok
					? textResult('The built-in server is running and reachable. Retry the run.')
					: textResult(builtinFailureGuidance('it started but is still refusing the connection'));
			} catch (e) {
				return textResult(builtinFailureGuidance(e instanceof Error ? e.message : String(e)));
			}
		},
	},
	{
		name: 'get_vm_resources',
		description: 'Read the built-in server (Qoka built-in VM) resource allocation - memory (MB), CPU cores, disk (GB). Only relevant when the built-in server is the ACTIVE run environment (not an SSH server). Call this to check capacity before running a heavy pipeline, or when a run fails with an out-of-memory error.',
		inputSchema: { type: 'object', properties: {} },
		handler: async () => {
			const { config } = services();
			const vm = config.get().local_vm;
			const active = config.isLocalVmActive();
			const lim = hostVmLimits();
			return textResult([
				`Built-in server (VM) resources - memory: ${vm.memoryMB} MB (~${Math.round(vm.memoryMB / 1024)} GB), CPU cores: ${vm.cpus}, disk: ${vm.diskGB} GB.`,
				active
					? 'The built-in server IS the active run environment.'
					: 'NOTE: an SSH server is currently active, not the built-in server - these settings only affect the built-in server.',
				`This computer's physical ceiling for the built-in server is ${Math.floor(lim.maxMemoryMB / 1024)} GB RAM / ${lim.maxCpus} CPU cores - it CANNOT go higher here. If a run needs more than that, it will run out of memory: just tell the user the run ran out of memory on the built-in server. Do NOT tell them to use an SSH server.`,
			].join('\n'));
		},
	},
	{
		name: 'set_vm_resources',
		description: "Change the built-in server (Qoka built-in VM) memory (memoryMB) and/or CPU cores (cpus). ONLY for the built-in server, never SSH servers. You MUST confirm the new values with the user BEFORE calling. Values are bounded by the host machine's physical RAM/CPU. Changes apply after the built-in server restarts. Use this when a pipeline fails for lack of memory: propose a higher memoryMB, confirm with the user, then set it and tell them to restart the built-in server. The built-in server is HARD-CAPPED by this computer's physical RAM/CPU (this tool reports the cap when you hit it). If a run needs MORE than that maximum, do NOT keep bumping memoryMB and do NOT tell the user to use an SSH server - simply tell them the run ran out of memory on the built-in server.",
		inputSchema: {
			type: 'object',
			properties: {
				memoryMB: { type: 'number', description: 'New memory in megabytes (e.g. 8192 for 8 GB). Omit to leave unchanged.' },
				cpus: { type: 'number', description: 'New CPU core count. Omit to leave unchanged.' },
			},
		},
		handler: async (args) => {
			const { config } = services();
			if (!config.isLocalVmActive()) {
				return textResult('The built-in server is not the active run environment (an SSH server is active). Resource changes only apply to the built-in server - ask the user to switch to it first.');
			}
			const lim = hostVmLimits();
			const patch: { memoryMB?: number; cpus?: number } = {};
			const mem = args?.memoryMB;
			const cpus = args?.cpus;
			let capped = false;
			if (typeof mem === 'number' && mem > 0) {
				patch.memoryMB = Math.min(Math.round(mem), lim.maxMemoryMB);
				if (Math.round(mem) > lim.maxMemoryMB) { capped = true; }
			}
			if (typeof cpus === 'number' && cpus > 0) {
				patch.cpus = Math.min(Math.round(cpus), lim.maxCpus);
				if (Math.round(cpus) > lim.maxCpus) { capped = true; }
			}
			if (patch.memoryMB === undefined && patch.cpus === undefined) {
				return textResult('Provide memoryMB and/or cpus (both must be > 0). Nothing changed.');
			}
			await config.setLocalVmResources(patch);
			const vm = config.get().local_vm;
			const base = `Built-in server resources updated - memory: ${vm.memoryMB} MB, CPU cores: ${vm.cpus}. Restart the built-in server to apply (Autopipe tab, built-in server gear, or it applies on next launch).`;
			if (capped) {
				const maxGB = Math.floor(lim.maxMemoryMB / 1024);
				return textResult(`${base}\n\nNOTE: the requested size exceeded THIS computer's physical limit, so it was capped at the maximum the built-in server can use here (${maxGB} GB / ${lim.maxCpus} cores). It cannot go higher on this machine. If a run still runs out of memory at this size, just tell the user it ran out of memory on the built-in server - do NOT suggest an SSH server.`);
			}
			return textResult(base);
		},
	},
];
