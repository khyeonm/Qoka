/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { ToolDefinition, textResult } from './types';
import { services } from '../../common/services';

// Built-in server (local QEMU VM) resource tools. These ONLY apply when the
// active run environment is the built-in VM — an SSH server's resources are the
// remote machine's and aren't ours to change.

export const VM_TOOLS: ToolDefinition[] = [
	{
		name: 'start_built_in_server',
		description: 'Start the Aria built-in server (local VM) when it is the selected run environment but is not running yet — e.g. when get_workspace_info reports it is not running. This begins downloading/booting it (about a minute or two). Call this instead of asking the user to press any button. After calling, tell the user it is starting, wait ~60-90 seconds, call get_workspace_info again, and once it reports a reachable endpoint, retry the pipeline step.',
		inputSchema: { type: 'object', properties: {} },
		handler: async () => {
			const { config } = services();
			if (!config.isLocalVmActive()) {
				return textResult('The built-in server is not the selected run environment (an SSH server is active), so there is nothing to start here.');
			}
			try {
				await vscode.commands.executeCommand('aria.autopipe.vm.setup');
			} catch (e) {
				return textResult(`Could not start the built-in server: ${e instanceof Error ? e.message : String(e)}`);
			}
			return textResult('Starting the Aria built-in server — it downloads/boots in the background (about a minute or two). Tell the user it is starting, wait ~60-90 seconds, then call get_workspace_info again; once it reports a reachable endpoint, retry the pipeline step.');
		},
	},
	{
		name: 'get_vm_resources',
		description: 'Read the built-in server (Aria built-in VM) resource allocation — memory (MB), CPU cores, disk (GB). Only relevant when the built-in server is the ACTIVE run environment (not an SSH server). Call this to check capacity before running a heavy pipeline, or when a run fails with an out-of-memory error.',
		inputSchema: { type: 'object', properties: {} },
		handler: async () => {
			const { config } = services();
			const vm = config.get().local_vm;
			const active = config.isLocalVmActive();
			return textResult([
				`Built-in server (VM) resources — memory: ${vm.memoryMB} MB (~${Math.round(vm.memoryMB / 1024)} GB), CPU cores: ${vm.cpus}, disk: ${vm.diskGB} GB.`,
				active
					? 'The built-in server IS the active run environment.'
					: 'NOTE: an SSH server is currently active, not the built-in server — these settings only affect the built-in server.',
				"These are bounded by the host machine's physical RAM/CPU.",
			].join('\n'));
		},
	},
	{
		name: 'set_vm_resources',
		description: "Change the built-in server (Aria built-in VM) memory (memoryMB) and/or CPU cores (cpus). ONLY for the built-in server, never SSH servers. You MUST confirm the new values with the user BEFORE calling. Values are bounded by the host machine's physical RAM/CPU. Changes apply after the built-in server restarts. Use this when a pipeline fails for lack of memory: propose a higher memoryMB, confirm with the user, then set it and tell them to restart the built-in server.",
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
				return textResult('The built-in server is not the active run environment (an SSH server is active). Resource changes only apply to the built-in server — ask the user to switch to it first.');
			}
			const patch: { memoryMB?: number; cpus?: number } = {};
			const mem = args?.memoryMB;
			const cpus = args?.cpus;
			if (typeof mem === 'number' && mem > 0) { patch.memoryMB = Math.round(mem); }
			if (typeof cpus === 'number' && cpus > 0) { patch.cpus = Math.round(cpus); }
			if (patch.memoryMB === undefined && patch.cpus === undefined) {
				return textResult('Provide memoryMB and/or cpus (both must be > 0). Nothing changed.');
			}
			await config.setLocalVmResources(patch);
			const vm = config.get().local_vm;
			return textResult(`Built-in server resources updated — memory: ${vm.memoryMB} MB, CPU cores: ${vm.cpus}. Restart the built-in server to apply (Autopipe tab → built-in server gear, or it applies on next launch).`);
		},
	},
];
