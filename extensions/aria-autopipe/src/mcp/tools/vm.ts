/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ToolDefinition, textResult } from './types';
import { services } from '../../common/services';
import { hostVmLimits } from '../../common/types';
import { ensureBuiltinServer, isReachable, restartBuiltinServer } from '../../runtime/builtinServer';
import { detectRunEnvResources, formatRunEnvResources } from '../../common/workspaceSync';

// Local run environment (local QEMU VM) resource tools. These ONLY apply when the
// active run environment is the local VM - an SSH server's resources are the
// remote machine's and aren't ours to change.

/**
 * Message for when the local run environment can't start / stay reachable. On Windows
 * the local run environment IS a WSL2 distro, so the most common cause is a missing
 * distribution (the WSL engine can be present - `wsl --version` works - while no
 * Ubuntu is installed). Surface a concrete check-and-install path there.
 */
function builtinFailureGuidance(reason: string): string {
	const base = `The local run environment could not be started (${reason}).`;
	if (process.platform === 'win32') {
		return [
			base,
			'',
			'On Windows the local run environment runs on WSL. Ask the user to check, in PowerShell:',
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
		description: '(Re)start and VERIFY the ACTIVE run connection - the local run environment OR the SSH server selected in the Settings tab. Call this whenever code cannot run because the connection is not ready: the local run environment is not running, an SSH server is unreachable, or a run just failed with a connection/refused error. For the local run environment it boots or restarts it and confirms it actually answers over SSH; for an SSH server it re-tests the connection and reports the endpoint. If the local run environment repeatedly fails to start on Windows, it tells you to check that WSL AND a Linux distribution (Ubuntu) are installed. Call this instead of asking the user to press a button. After it reports the connection is up, retry the run.',
		inputSchema: { type: 'object', properties: {} },
		handler: async () => {
			const { config, ssh } = services();

			// SSH server is the active target: don't touch the local run environment -
			// just re-test the connection (ssh2 opens a fresh connection each call,
			// so a probe IS the reconnect) and report the endpoint.
			if (!config.isLocalVmActive()) {
				const profile = config.activeProfile();
				if (!profile) {
					return textResult('No run connection is selected. Open the Settings tab and choose the local run environment or an SSH server, then try again.');
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

			// Local run environment is the active target: ensure it is up, and if it does
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
					? textResult('The local run environment is running and reachable. Retry the run.')
					: textResult(builtinFailureGuidance('it started but is still refusing the connection'));
			} catch (e) {
				return textResult(builtinFailureGuidance(e instanceof Error ? e.message : String(e)));
			}
		},
	},
	{
		name: 'get_vm_resources',
		description: 'Measure the ACTIVE run connection\'s REAL resources - CPU cores, RAM, free disk - by probing INSIDE it live (works for the local run environment AND an SSH server). Values are detected at call time (nproc / free / df), never Qoka config. Call this only when you need to SIZE a heavy run (thread counts, batch/chunk sizes) or when a run fails out of memory - do NOT report the numbers to the user unless they ask.',
		inputSchema: { type: 'object', properties: {} },
		handler: async () => {
			const { config } = services();
			const profile = config.activeProfile();
			if (!profile) {
				if (config.isLocalVmActive()) {
					return textResult('The local run environment is selected but not running yet, so its resources cannot be measured. Call start_server, wait ~60-90s, then retry.');
				}
				return textResult('No run connection is active. Select the local run environment or an SSH server first, then retry.');
			}
			const r = await detectRunEnvResources(profile);
			const summary = formatRunEnvResources(r);
			if (!summary) {
				return textResult('Could not measure the run environment resources right now (the probe returned nothing). Try start_server, then retry.');
			}
			const wslNote = process.platform === 'win32' && config.isLocalVmActive()
				? ' On Windows this is a WSL2 environment sharing the host; its ceiling follows the user\'s .wslconfig, not Qoka.'
				: '';
			return textResult(
				`Run environment resources (measured live inside the active connection): ${summary}.${wslNote}`
				+ ' Use these to size the run efficiently (thread counts, batch/chunk sizes). Do NOT report these numbers to the user unless they explicitly ask. If a run runs out of memory, just tell the user it ran out of memory on the run environment; do NOT suggest switching servers.',
			);
		},
	},
	{
		name: 'set_vm_resources',
		description: "CAP the local run environment to a specific memory (memoryMB) and/or CPU core (cpus) limit. Call this ONLY when the user EXPLICITLY asks to restrict resources (e.g. \"use only 4 cores / 8 GB\") - NEVER proactively. By default the local run environment auto-uses the host resources efficiently, so there is normally nothing to set. ONLY for the local run environment, never SSH servers. On Windows (WSL2) this does not apply - WSL sizing is set by the user .wslconfig, not here. Values are bounded by the host physical RAM/CPU. Changes apply after the local run environment restarts.",
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
				return textResult('The local run environment is not the active run environment (an SSH server is active). Resource changes only apply to the local run environment - ask the user to switch to it first.');
			}
			// On Windows the local run environment is WSL2, which shares the host's
			// resources and ignores these memoryMB/cpus values (they only bound the
			// QEMU/vfkit VM on Mac/Linux). Changing them here would be a silent no-op,
			// so say so instead: WSL sizing is set by the user's .wslconfig.
			if (process.platform === 'win32') {
				return textResult('On Windows the local run environment runs on WSL2, which shares this computer\'s resources - it has no fixed memory/CPU allocation to change here (there is no 4 GB / 2-core cap). If the user needs to bound or raise WSL\'s memory/CPUs, that is set in their .wslconfig file, not by Qoka. Nothing was changed.');
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
			const base = `Local run environment resources updated - memory: ${vm.memoryMB} MB, CPU cores: ${vm.cpus}. Restart the local run environment to apply (Settings tab, local run environment gear, or it applies on next launch).`;
			if (capped) {
				const maxGB = Math.floor(lim.maxMemoryMB / 1024);
				return textResult(`${base}\n\nNOTE: the requested size exceeded THIS computer's physical limit, so it was capped at the maximum the local run environment can use here (${maxGB} GB / ${lim.maxCpus} cores). It cannot go higher on this machine. If a run still runs out of memory at this size, just tell the user it ran out of memory on the local run environment - do NOT suggest an SSH server.`);
			}
			return textResult(base);
		},
	},
];
