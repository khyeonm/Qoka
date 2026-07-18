/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { ensureVm } from './vmBoot';
import { startRehAndForward } from './rehConnect';
import { startFileShare, ShareSession } from './fileShare';
import { SshEndpoint } from './rehConnect';
import { ProgressFn } from './vm/provisioner';

/**
 * aria-remote: resolves the `aria-vm` remote authority. A window opened on
 * `vscode-remote://aria-vm+<label>/<path>` calls resolve() here; we boot (or
 * attach to) the VM, share the host project folder in via sshfs, launch the
 * baked-in aria-reh server inside the VM, forward its port to the host, and
 * return that as the ResolvedAuthority. From then on the renderer talks to the
 * extension host running in the VM — extensions, CLIs, MCP and the terminal all
 * live there; only this resolver and aria-authentication stay on the host (both
 * extensionKind: ["ui"]).
 */

/** Default guest path the shared host project folder is mounted at. */
const GUEST_WORKSPACE = '/home/aria/project';

export function activate(context: vscode.ExtensionContext): void {
	const output = vscode.window.createOutputChannel('Aria Remote (VM)');
	context.subscriptions.push(output);
	const log = (line: string) => output.append(line.endsWith('\n') ? line : line + '\n');

	context.subscriptions.push(
		vscode.workspace.registerRemoteAuthorityResolver('aria-vm', {
			async resolve(authority: string): Promise<vscode.ResolvedAuthority> {
				log(`[aria-remote] resolving ${authority}`);
				return vscode.window.withProgress(
					{ location: vscode.ProgressLocation.Notification, title: 'Connecting to the Aria VM…', cancellable: false },
					async (progress) => {
						try {
							progress.report({ message: 'Starting the run environment…' });
							const progressFn: ProgressFn = (message) => progress.report({ message: message ?? 'Starting the run environment…' });
							const vm = await ensureVm(context, progressFn, log);

							// Share the host project folder into the VM (optional: a
							// failure here must not block the connection — the window
							// still opens, just without the mounted folder).
							progress.report({ message: 'Sharing the project folder…' });
							const share = await maybeStartShare(vm.endpoint, log);

							progress.report({ message: 'Launching the extension host…' });
							const reh = await startRehAndForward(vm.endpoint, log);

							context.subscriptions.push({
								dispose: () => { reh.dispose(); share?.dispose(); vm.dispose(); },
							});
							log(`[aria-remote] resolved to 127.0.0.1:${reh.localPort}`);
							return new vscode.ResolvedAuthority('127.0.0.1', reh.localPort, reh.connectionToken);
						} catch (err) {
							const message = err instanceof Error ? err.message : String(err);
							log(`[aria-remote] resolve FAILED: ${message}`);
							output.show();
							throw vscode.RemoteAuthorityResolverError.NotAvailable(message, true);
						}
					},
				);
			},
		}),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('aria.remote.showLog', () => output.show()),
	);

	// Re-open the current window's project folder inside the VM. The host folder
	// is mounted at GUEST_WORKSPACE via sshfs; opening that path over the aria-vm
	// authority routes the window through resolve() above.
	context.subscriptions.push(
		vscode.commands.registerCommand('aria.remote.openWindow', async () => {
			const uri = vscode.Uri.parse(`vscode-remote://aria-vm+builtin${GUEST_WORKSPACE}`);
			await vscode.commands.executeCommand('vscode.openFolder', uri, { forceNewWindow: false });
		}),
	);
}

/** Start the host→guest file share if configured, else skip (window still opens). */
async function maybeStartShare(ssh: SshEndpoint, log: (line: string) => void): Promise<ShareSession | undefined> {
	const cfg = vscode.workspace.getConfiguration('aria.remote');
	const hostFolder = process.env.ARIA_SHARE_FOLDER || cfg.get<string>('shareFolder');
	const rclonePath = process.env.ARIA_RCLONE_PATH || cfg.get<string>('rclonePath');
	if (!hostFolder || !rclonePath) {
		log('[aria-remote] file share skipped — set aria.remote.shareFolder + aria.remote.rclonePath (or ARIA_SHARE_FOLDER + ARIA_RCLONE_PATH).');
		return undefined;
	}
	try {
		return await startFileShare({ hostFolder, ssh, rclonePath }, log);
	} catch (e) {
		log(`[aria-remote] file share failed (continuing without it): ${e instanceof Error ? e.message : String(e)}`);
		return undefined;
	}
}

export function deactivate(): void {
	// Subscriptions (output channel, resolver, forwarders, share) are disposed by the host.
}
