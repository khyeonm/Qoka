/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { ToolDefinition, textResult, errorResult } from './types';
import { services } from '../../common/services';

export const PLUGIN_TOOLS: ToolDefinition[] = [
	{
		name: 'list_installed_plugins',
		description: 'List all viewer plugins installed locally for Aria, with their supported file extensions and versions. Plugins live under ~/.aria-autopipe-plugins/ and work across every SSH host the user connects to.',
		inputSchema: { type: 'object', properties: {} },
		handler: async () => {
			// Single-user, local plugin set: no SSH round-trip needed.
			// `PluginService` scans the install directory and returns the
			// parsed manifests; we format them for the AI.
			try {
				const { plugins } = services();
				const installed = plugins.listInstalled();
				if (installed.length === 0) {
					return textResult([
						`No plugins installed under ${plugins.pluginsDirectory()} yet.`,
						'',
						'They are normally fetched from Autopipe Hub on first run. If the bootstrap failed, open Aria → Autopipe → Plugins and use the Install / Update buttons.',
					].join('\n'));
				}
				const lines = installed.map(p =>
					`  ${p.manifest.name} v${p.manifest.version} — handles ${p.manifest.extensions.join(', ')}` +
					(p.manifest.description ? `\n    ${p.manifest.description}` : ''),
				);
				return textResult([
					`Plugins under ${plugins.pluginsDirectory()}:`,
					'',
					...lines,
				].join('\n'));
			} catch (err) {
				return errorResult((err as Error).message);
			}
		},
	},
	{
		name: 'open_plugin_dir',
		description: 'Open the local Aria plugins directory in the OS file explorer. Useful for manually inspecting or editing plugin code during development.',
		inputSchema: { type: 'object', properties: {} },
		handler: async () => {
			try {
				const { plugins } = services();
				const uri = vscode.Uri.file(plugins.pluginsDirectory());
				await vscode.env.openExternal(uri);
				return textResult([
					`Opened ${uri.fsPath} in your file manager.`,
					'',
					'Plugin development guide: https://hub.autopipe.org/plugins/guide',
				].join('\n'));
			} catch (err) {
				return errorResult(`open_plugin_dir failed: ${(err as Error).message}`);
			}
		},
	},
];
