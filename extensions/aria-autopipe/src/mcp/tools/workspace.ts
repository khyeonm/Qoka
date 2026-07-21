/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ToolDefinition, textResult } from './types';
import { services } from '../../common/services';
import { workspacePathsFor } from '../../common/types';
import { lastKnownReachable } from '../../runtime/builtinServer';
import {
	SNAKEFILE_TEMPLATE, DOCKERFILE_TEMPLATE, CONFIG_YAML_TEMPLATE,
	RO_CRATE_METADATA_TEMPLATE, GENERATION_GUIDE,
} from '../../common/templates';

// Workspace / configuration / templates / generation guidance.

export const WORKSPACE_TOOLS: ToolDefinition[] = [
	{
		name: 'get_workspace_info',
		description: 'Get the workspace paths and the ACTIVE run connection (built-in server or SSH). Call this FIRST - before writing OR running any code - to confirm where code runs and where pipelines and outputs are stored. ROUTING - when the user wants to WRITE, RUN, or EXECUTE code, you MUST use a Qoka MCP tool and NEVER your own terminal / bash / shell tool: a QUICK one-off script (version check, short bash/python) -> run_code on the qoka-run MCP; a LONG / multi-step / reproducible pipeline -> execute_pipeline on this autopipe MCP. These two are the ONLY correct ways to run code - the terminal is never one of them. If it is unclear which they want, ASK. Both run on whatever connection is active (built-in OR SSH). For other tasks, prefer the matching Qoka MCP tool or installed Qoka skill over your generic capabilities.',
		inputSchema: { type: 'object', properties: {} },
		handler: async () => {
			const { config } = services();
			const cfg = config.get();
			const profile = config.activeProfile();
			// Surfacing what the handler actually saw makes it easy to
			// tell whether a "stale data" complaint is our cache or
			// Claude's conversational memory. Look in the Qoka DevTools
			// console (Help → Toggle Developer Tools).
			console.log('[aria-autopipe] get_workspace_info called', {
				profileId: cfg.active_ssh_profile_id,
				profileCount: cfg.ssh_profiles.length,
				active: profile ? `${profile.username}@${profile.host}` : null,
				github: cfg.github?.login ?? (cfg.github?.token ? 'connected' : 'disconnected'),
			});
			if (!profile) {
				// The user may have chosen the built-in server (no SSH profile). When
				// it isn't running yet, activeProfile() is null - but do NOT tell the
				// AI to add an SSH server; guide it to start the built-in one instead.
				if (config.isLocalVmActive()) {
					const vm = cfg.local_vm;
					return textResult([
						'Run environment: the Qoka built-in server (local VM) is selected, but it is NOT running yet, so there is no reachable endpoint right now.',
						'Do NOT ask the user to add an SSH server, and do NOT tell them to press a button - that is not the flow.',
						'If it is not running, call the start_server tool to start AND verify it (it restarts and re-checks the connection, and on Windows tells you to check WSL/Ubuntu if it keeps failing). Tell the user it is starting, wait ~60-90 seconds, then call get_workspace_info again and retry. If it is already downloading/booting, just wait and retry.',
						`Configured resources (apply on start): memory ${vm.memoryMB} MB (~${Math.round(vm.memoryMB / 1024)} GB), CPU cores ${vm.cpus}, disk ${vm.diskGB} GB.`,
						'',
						`Registry: ${cfg.registry_url}`,
						`GitHub: ${cfg.github?.login ? `connected as @${cfg.github.login}` : 'not connected'}`,
					].join('\n'));
				}
				return textResult([
					'No active SSH profile configured yet.',
					'',
					'Open the Autopipe tab in the activity bar, click "+" on the SSH connection section, fill in host / port / username / password / remote workspace, then Save profile and press Save settings. Or use the built-in server instead - no SSH needed.',
					'',
					`Registry: ${cfg.registry_url}`,
					`GitHub: ${cfg.github?.login ? `connected as @${cfg.github.login}` : 'not connected'}`,
					`Upload mode: ${cfg.per_pipeline_repo ? 'Per-pipeline repo' : `Single repo (${cfg.github_repo || 'unset'})`}`,
					'',
					`Live config mirror (inspect for debugging): ${config.diskConfigPath()}`,
				].join('\n'));
			}

			const paths = workspacePathsFor(profile);
			// Report what the last probe found WITHOUT opening a connection. This used
			// to call canConnect, but the AI is told to call get_workspace_info before
			// every run, so that was one extra SSH login per run - enough to push a
			// server that limits rapid logins into refusing the run itself.
			const reachable = lastKnownReachable(profile);
			// GitHub is "connected" iff we have a token. The login field is
			// best-effort metadata from /user - it can be missing if the API
			// call failed at OAuth time, but the token is still good for
			// uploads, so we shouldn't tell the user they're disconnected.
			const ghLine = cfg.github?.token
				? `GitHub: connected${cfg.github.login ? ` as @${cfg.github.login}` : ''}`
				: 'GitHub: Not connected - open the Autopipe tab in the activity bar, find the GitHub section, and click "Connect to GitHub" to log in.';
			return textResult([
				`SSH: ${profile.username}@${profile.host}:${profile.port}`,
				`Connection: ${reachable ? 'reachable (checked moments ago)' : 'not verified just now - just run; if it cannot connect the run will say so, and start_server can re-establish it'}`,
				config.isLocalVmActive()
					? `Run environment: Qoka built-in server (local VM) - memory ${cfg.local_vm.memoryMB} MB (~${Math.round(cfg.local_vm.memoryMB / 1024)} GB), CPU cores ${cfg.local_vm.cpus}, disk ${cfg.local_vm.diskGB} GB. These reflect the user's current UI settings - honour them for this run; if the run needs more, propose set_vm_resources.`
					: 'Run environment: user-provided SSH server.',
				`Repo path: ${paths.repo_path}`,
				`Pipelines: ${paths.pipelines_dir}`,
				`Input: ${paths.input_dir}`,
				`Output: ${paths.output_dir}`,
				`Log: ${paths.log_dir}`,
				`Plugins: ${paths.plugins_dir}`,
				'',
				ghLine,
				`Upload mode: ${cfg.per_pipeline_repo ? 'Per-pipeline repo (each pipeline gets its own GitHub repo)' : `Single repo (${cfg.github_repo || 'unset'})`}`,
				'',
				`Live config mirror (inspect for debugging): ${config.diskConfigPath()}`,
			].join('\n'));
		},
	},
	{
		name: 'get_templates',
		description: 'Get pipeline file templates for creating new pipelines',
		inputSchema: { type: 'object', properties: {} },
		handler: async () => textResult([
			'AutoPipe pipeline templates. Use these as starting points when creating a new pipeline:',
			'',
			'### Snakefile',
			SNAKEFILE_TEMPLATE,
			'',
			'### Dockerfile',
			DOCKERFILE_TEMPLATE,
			'',
			'### config.yaml',
			CONFIG_YAML_TEMPLATE,
			'',
			'### ro-crate-metadata.json',
			RO_CRATE_METADATA_TEMPLATE,
		].join('\n')),
	},
	{
		name: 'get_generation_guide',
		description: 'Get the pipeline generation guide with rules for Snakefiles and Dockerfiles',
		inputSchema: { type: 'object', properties: {} },
		handler: async () => textResult(GENERATION_GUIDE),
	},
];
