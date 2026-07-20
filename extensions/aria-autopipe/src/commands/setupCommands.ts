/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as crypto from 'crypto';
import { services } from '../common/services';
import { SshProfile } from '../common/types';

/**
 * Multi-step input flows for the Setup section of the Autopipe panel.
 *
 * We use `vscode.window.showInputBox` / `showQuickPick` instead of a webview
 * form so the user gets the standard VS Code modal experience and we don't
 * have to ship form rendering / validation code in HTML. Each command is
 * idempotent - running it again edits the existing entity in place.
 */

export function registerSetupCommands(context: vscode.ExtensionContext): void {

	// ── SSH profile management ──────────────────────────────────────────

	context.subscriptions.push(
		vscode.commands.registerCommand('aria.autopipe.ssh.add', async () => {
			const name = await vscode.window.showInputBox({
				prompt: 'SSH profile name (e.g. "lab server")',
				placeHolder: 'A friendly label for this connection',
				ignoreFocusOut: true,
			});
			if (!name) {
				return;
			}
			const host = await vscode.window.showInputBox({
				prompt: 'SSH host',
				placeHolder: 'server.example.com or 10.0.0.5',
				ignoreFocusOut: true,
			});
			if (!host) {
				return;
			}
			const portStr = await vscode.window.showInputBox({
				prompt: 'SSH port',
				value: '22',
				ignoreFocusOut: true,
				validateInput: v => /^\d+$/.test(v) && Number(v) > 0 ? null : 'Port must be a positive integer',
			});
			if (!portStr) {
				return;
			}
			const username = await vscode.window.showInputBox({
				prompt: 'Username',
				ignoreFocusOut: true,
			});
			if (!username) {
				return;
			}
			const authChoice = await vscode.window.showQuickPick(
				[
					{ label: 'SSH agent (recommended - ssh-add already loaded your key)', value: 'agent' as const },
					{ label: 'SSH key file (point to ~/.ssh/id_ed25519 or similar)', value: 'key' as const },
				],
				{ placeHolder: 'How should Qoka authenticate?' },
			);
			if (!authChoice) {
				return;
			}
			let keyPath: string | undefined;
			if (authChoice.value === 'key') {
				keyPath = await vscode.window.showInputBox({
					prompt: 'Absolute path to the private key file',
					placeHolder: '/home/you/.ssh/id_ed25519',
					ignoreFocusOut: true,
				});
				if (!keyPath) {
					return;
				}
			}
			const repoPath = await vscode.window.showInputBox({
				prompt: 'Remote workspace directory (where pipelines/, pipelines_input/, pipelines_output/ will live)',
				placeHolder: '/home/you/aria',
				ignoreFocusOut: true,
			});
			if (!repoPath) {
				return;
			}

			const profile: SshProfile = {
				id: crypto.randomUUID(),
				name,
				host,
				port: Number(portStr),
				username,
				auth: keyPath ? { type: 'key', key_path: keyPath } : { type: 'agent' },
				repo_path: repoPath,
			};
			await services().config.addOrUpdateProfile(profile);
			// First profile auto-becomes the active one - saves the user a
			// follow-up "set active" click in the common case.
			const cfg = services().config.get();
			if (!cfg.active_ssh_profile_id) {
				await services().config.setActiveProfile(profile.id);
			}
			vscode.window.showInformationMessage(`Saved SSH profile "${name}".`);
		}),

		vscode.commands.registerCommand('aria.autopipe.ssh.saveFromDraft', async (draft: {
			id?: string;
			name: string;
			host: string;
			port: number;
			username: string;
			auth: 'agent' | 'key' | 'password';
			keyPath?: string;
			password?: string;
			repoPath: string;
		}) => {
			// Companion to the in-panel SSH form: the view collects the
			// fields and hands us a fully-formed draft. We validate the
			// per-auth-type fields and write the profile to globalState.
			if (!draft || !draft.name || !draft.host || !draft.username || !draft.repoPath) {
				vscode.window.showErrorMessage('SSH form is missing required fields.');
				throw new Error('invalid draft');
			}
			let auth: SshProfile['auth'];
			if (draft.auth === 'key') {
				auth = { type: 'key', key_path: draft.keyPath };
			} else if (draft.auth === 'password') {
				// On EDIT (id present) with a blank password, keep the existing one so
				// the user is not forced to retype it.
				let pw = draft.password;
				if (!pw && draft.id) {
					const existing = services().config.get().ssh_profiles.find(p => p.id === draft.id);
					pw = existing?.auth.type === 'password' ? existing.auth.password : undefined;
				}
				auth = { type: 'password', password: pw };
			} else {
				auth = { type: 'agent' };
			}
			const profile: SshProfile = {
				id: draft.id || crypto.randomUUID(),
				name: draft.name,
				host: draft.host,
				port: draft.port,
				username: draft.username,
				auth,
				repo_path: draft.repoPath,
			};
			await services().config.addOrUpdateProfile(profile);
			const cfg = services().config.get();
			if (!cfg.active_ssh_profile_id) {
				await services().config.setActiveProfile(profile.id);
			}
			vscode.window.showInformationMessage(`Saved SSH profile "${draft.name}".`);
		}),

		// Editable fields for the Connections edit form. Password intentionally
		// omitted - the form keeps the existing one when left blank (saveFromDraft).
		vscode.commands.registerCommand('aria.autopipe.ssh.getProfile', (id: string) => {
			const p = services().config.get().ssh_profiles.find(x => x.id === id);
			return p ? { id: p.id, name: p.name, host: p.host, port: p.port, username: p.username, repoPath: p.repo_path } : null;
		}),

		vscode.commands.registerCommand('aria.autopipe.ssh.remove', async (id?: string) => {
			const cfg = services().config.get();
			if (cfg.ssh_profiles.length === 0) {
				vscode.window.showInformationMessage('No SSH profiles to remove.');
				return;
			}
			// The per-row trash button passes the profile id directly; without one
			// (e.g. a command-palette call) fall back to a picker.
			let targetId = id;
			let targetName = cfg.ssh_profiles.find(p => p.id === id)?.name;
			if (!targetId) {
				const pick = await vscode.window.showQuickPick(
					cfg.ssh_profiles.map(p => ({ label: p.name, description: `${p.username}@${p.host}:${p.port}`, id: p.id })),
					{ placeHolder: 'Which profile do you want to remove?' },
				);
				if (!pick) {
					return;
				}
				targetId = pick.id;
				targetName = pick.label;
			}
			const ok = await vscode.window.showWarningMessage(`Remove SSH profile "${targetName ?? ''}"?`, { modal: true }, 'Remove');
			if (ok !== 'Remove') {
				return;
			}
			await services().config.removeProfile(targetId);
			vscode.window.showInformationMessage(`Removed profile "${targetName ?? ''}".`);
		}),

		vscode.commands.registerCommand('aria.autopipe.ssh.setActiveById', async (id: string) => {
			// Companion to the in-panel profile dropdown: the view passes
			// the picked profile id, we just flip the active pointer.
			await services().config.setActiveProfile(id);
		}),

		vscode.commands.registerCommand('aria.autopipe.repo.setModeValue', async (mode: 'per-pipeline' | 'single') => {
			// Used by the radio buttons inside the GitHub section. Wraps a
			// plain config update so the view doesn't have to know the
			// config field names.
			await services().config.update({ per_pipeline_repo: mode === 'per-pipeline' });
		}),

		vscode.commands.registerCommand('aria.autopipe.repo.setRepoName', async (name: string) => {
			await services().config.update({ github_repo: name });
		}),

		vscode.commands.registerCommand('aria.autopipe.settings.confirmSaved', async () => {
			// Fired by the panel's Save button. Rewrite the disk mirror
			// unconditionally so the file timestamp moves with every
			// click, then re-register the MCP server with Claude Code so
			// any change to SSH/GitHub/repo wiring propagates in one
			// action - no separate Re-register button to remember.
			await services().config.update({});
			const diskPath = services().config.diskConfigPath();
			// Wrap the re-registration in a progress toast so the user
			// gets the same "connecting…" feedback they see on activate.
			await vscode.window.withProgress(
				{
					location: vscode.ProgressLocation.Notification,
					title: 'Autopipe - re-registering MCP…',
					cancellable: false,
				},
				async () => {
					try {
						await vscode.commands.executeCommand('aria.autopipe.reregister', true);
					} catch {
						// reregister surfaces its own error toast
					}
				},
			);
			vscode.window.showInformationMessage(`Settings saved to ${diskPath}`);
		}),

		vscode.commands.registerCommand('aria.autopipe.ssh.setActive', async () => {
			const cfg = services().config.get();
			if (cfg.ssh_profiles.length === 0) {
				vscode.window.showWarningMessage('Add an SSH profile first via Qoka → Autopipe → Setup.');
				return;
			}
			const pick = await vscode.window.showQuickPick(
				cfg.ssh_profiles.map(p => ({
					label: p.name,
					description: `${p.username}@${p.host}:${p.port}` + (p.id === cfg.active_ssh_profile_id ? ' (current)' : ''),
					id: p.id,
				})),
				{ placeHolder: 'Choose the active SSH profile' },
			);
			if (!pick) {
				return;
			}
			await services().config.setActiveProfile(pick.id);
			vscode.window.showInformationMessage(`Active profile: ${pick.label}`);
		}),

		vscode.commands.registerCommand('aria.autopipe.ssh.test', async () => {
			const profile = services().config.activeProfile();
			if (!profile) {
				vscode.window.showWarningMessage('No active SSH profile. Add or select one first.');
				return;
			}
			vscode.window.withProgress(
				{ location: vscode.ProgressLocation.Notification, title: `Testing SSH to ${profile.host}…` },
				async () => {
					const result = await services().ssh.testConnection(profile);
					if (result.ok) {
						vscode.window.showInformationMessage(`SSH OK: ${profile.username}@${profile.host}`);
					} else {
						vscode.window.showErrorMessage(`SSH failed: ${result.message}`);
					}
				},
			);
		}),

		// ── GitHub OAuth Device Flow ────────────────────────────────────

		vscode.commands.registerCommand('aria.autopipe.github.login', async () => {
			const { github, config } = services();
			let start;
			try {
				start = await github.startDeviceFlow();
			} catch (err) {
				vscode.window.showErrorMessage(`GitHub login failed to start: ${(err as Error).message}`);
				return;
			}

			// Copy the user code to the clipboard so the user just pastes it
			// into the GitHub device-code page.
			await vscode.env.clipboard.writeText(start.user_code);
			const choice = await vscode.window.showInformationMessage(
				`Enter this code on GitHub:\n\n${start.user_code}\n\n(Already copied to clipboard.)`,
				'Open GitHub',
				'Cancel',
			);
			if (choice !== 'Open GitHub') {
				return;
			}
			vscode.env.openExternal(vscode.Uri.parse(start.verification_uri));

			await vscode.window.withProgress(
				{ location: vscode.ProgressLocation.Notification, title: 'Waiting for GitHub authorization…' },
				async () => {
					const deadline = Date.now() + start.expires_in * 1000;
					let delaySec = Math.max(5, start.interval || 5);
					while (Date.now() < deadline) {
						await new Promise((r) => setTimeout(r, delaySec * 1000));
						const result = await github.pollForToken(start.device_code);
						if (result.status === 'authorized' && result.token) {
							await config.update({
								github: { token: result.token, login: result.login },
							});
							vscode.window.showInformationMessage(
								`GitHub connected as @${result.login ?? '(unknown)'}.`,
							);
							return;
						}
						if (result.status === 'slow_down') {
							delaySec += 5;
						}
						if (result.status === 'denied' || result.status === 'expired') {
							vscode.window.showErrorMessage(`GitHub login ${result.status}.`);
							return;
						}
						if (result.status === 'error') {
							vscode.window.showErrorMessage(`GitHub login error: ${result.message}`);
							return;
						}
					}
					vscode.window.showWarningMessage('GitHub login timed out. Try again from Qoka → Autopipe → GitHub.');
				},
			);
		}),

		vscode.commands.registerCommand('aria.autopipe.github.logout', async () => {
			await services().config.update({ github: null });
			vscode.window.showInformationMessage('Signed out of GitHub.');
		}),

		// ── Repo + Registry settings ─────────────────────────────────────

		vscode.commands.registerCommand('aria.autopipe.repo.setMode', async () => {
			const pick = await vscode.window.showQuickPick(
				[
					{ label: 'Per-pipeline repo (each pipeline gets its own GitHub repo)', value: true },
					{ label: 'Single repo (all pipelines live under one shared repo)', value: false },
				],
				{ placeHolder: 'How should Qoka upload pipelines?' },
			);
			if (!pick) {
				return;
			}
			const update: Partial<{ per_pipeline_repo: boolean; github_repo: string }> = { per_pipeline_repo: pick.value };
			if (pick.value === false) {
				const repoName = await vscode.window.showInputBox({
					prompt: 'Shared GitHub repo name (used for every pipeline upload)',
					placeHolder: 'aria-pipelines',
					value: services().config.get().github_repo,
					ignoreFocusOut: true,
				});
				if (repoName === undefined) {
					return;
				}
				update.github_repo = repoName;
			}
			await services().config.update(update);
			vscode.window.showInformationMessage(`Upload mode: ${pick.label}`);
		}),

		vscode.commands.registerCommand('aria.autopipe.registry.setUrl', async () => {
			const current = services().config.get().registry_url;
			const url = await vscode.window.showInputBox({
				prompt: 'Autopipe Hub URL',
				value: current,
				ignoreFocusOut: true,
				validateInput: v => /^https?:\/\//i.test(v) ? null : 'Must start with http:// or https://',
			});
			if (!url) {
				return;
			}
			await services().config.update({ registry_url: url });
			vscode.window.showInformationMessage(`Registry: ${url}`);
		}),
	);
}
