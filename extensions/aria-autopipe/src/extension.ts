/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { detectAiProviders } from './detection/claudeCodeDetector';
import { AriaAutopipeMcpServer } from './mcp/server';
import { registerWithClaudeCode, unregisterFromClaudeCode } from './registration/claudeCodeMcp';
import { registerWithCodex, unregisterFromCodex } from './registration/codexMcp';
import { ConfigService } from './config/configService';
import { SshService } from './ssh/sshService';
import { VMManager } from './vm/vmManager';
import { HubApiClient } from './hub/apiClient';
import { GitHubAuthService } from './github/oauthService';
import { setServices } from './common/services';
import { registerSetupCommands } from './commands/setupCommands';
import { PluginService, DEFAULT_PLUGIN_NAMES } from './plugins/pluginService';
import { openHubPanel } from './panels/hubPanel';
import { openPluginsPanel } from './panels/pluginsPanel';

let mcpServer: AriaAutopipeMcpServer | undefined;
interface ClientRegistration {
	ok: boolean;
	message: string;
	port: number | null;
}
let lastRegistration: { claude: ClientRegistration; codex: ClientRegistration } = {
	claude: { ok: false, message: 'not attempted', port: null },
	codex: { ok: false, message: 'not attempted', port: null },
};

export function activate(context: vscode.ExtensionContext): void {
	console.log('[aria-autopipe] activate()');

	// Wire up the shared service container so MCP tool handlers can reach
	// config / ssh / hub / github without each of them tracking the
	// dependency graph individually.
	const config = new ConfigService(context);
	const services = {
		config,
		ssh: new SshService(),
		hub: new HubApiClient(config.get().registry_url),
		github: new GitHubAuthService(),
		plugins: new PluginService(),
	};
	setServices(services);

	// Built-in local VM ("Aria built-in" Run environment). Runs pipelines on a
	// bundled QEMU Linux guest (Mac/Win) or a dev SSH stand-in (Linux), exposed
	// to the rest of autopipe as a synthetic SSH profile.
	const vm = new VMManager(context, config);
	context.subscriptions.push({ dispose: () => vm.dispose() });

	// First run: default the built-in VM as the active target so the user has a
	// working environment without configuring a server. Only on Mac/Win, or on
	// Linux when a dev stand-in is set (Linux users otherwise run locally). Never
	// overrides an existing choice.
	const boot = config.get();
	const hasStandin = !!(process.env.ARIA_AUTOPIPE_VM_STANDIN
		|| vscode.workspace.getConfiguration('aria.autopipe').get<string>('vmStandin'));
	if (!boot.active_ssh_profile_id && boot.ssh_profiles.length === 0 && (process.platform !== 'linux' || hasStandin)) {
		void config.activateLocalVm();
	}
	// Bring the VM up if it's the active target (dev: eager start; production
	// lazy-start-on-first-pipeline lands in M4). Fire-and-forget.
	if (config.isLocalVmActive()) {
		void vm.start().catch(err => console.error('[aria-autopipe] built-in VM start failed:', err));
	}
	context.subscriptions.push(
		vscode.commands.registerCommand('aria.autopipe.vm.setActive', () => config.activateLocalVm()),
		vscode.commands.registerCommand('aria.autopipe.vm.start', () => vm.start()),
		vscode.commands.registerCommand('aria.autopipe.vm.stop', () => vm.stop()),
		vscode.commands.registerCommand('aria.autopipe.vm.status', () => ({ status: vm.status(), error: vm.lastError(), progress: vm.progress() })),
		// "Set up now": make the built-in VM active and provision+boot it.
		vscode.commands.registerCommand('aria.autopipe.vm.setup', async () => {
			await config.activateLocalVm();
			await vm.start();
		}),
		// Reset recreates the throwaway overlay (data on the shared workspace is
		// kept). Confirm because it interrupts any running VM.
		vscode.commands.registerCommand('aria.autopipe.vm.reset', async () => {
			const ok = await vscode.window.showWarningMessage(
				'Reset the built-in run environment? Your pipelines and data are kept (they live in the shared workspace); only the VM itself is rebuilt.',
				{ modal: true }, 'Reset');
			if (ok !== 'Reset') { return; }
			await vm.reset();
			await vm.start();
		}),
		// Resource overrides (RAM/CPU) — applied on next VM start.
		vscode.commands.registerCommand('aria.autopipe.vm.setResources', (patch: unknown) =>
			config.setLocalVmResources((patch ?? {}) as { memoryMB?: number; cpus?: number })),
	);

	// Register the SSH/GitHub/Repo/Registry setup commands the panel calls.
	registerSetupCommands(context);

	// First-run plugin bootstrap. Fires non-blocking so the rest of activate
	// can proceed; the user sees a progress toast while it runs.
	void bootstrapDefaultPlugins(services.plugins, services.hub);

	// Keep the Hub client's base URL in sync with config changes (the user
	// can switch registries by editing config, even though we don't yet
	// expose a UI for it).
	context.subscriptions.push(
		config.onDidChange((cfg) => {
			services.hub = new HubApiClient(cfg.registry_url);
			setServices(services);
		}),
	);

	mcpServer = new AriaAutopipeMcpServer();

	// Auto-detect newly-installed AI extensions so the user doesn't have to
	// reload the window after installing Claude Code or Codex. Fires on any
	// extension install/uninstall/enable/disable; we filter to the providers
	// we care about and only re-register when something newly came online.
	context.subscriptions.push(
		vscode.extensions.onDidChange(() => {
			void refreshAiRegistrations();
		}),
	);

	// Wrap the MCP boot + register flow in a notification so the user sees
	// a bottom-right toast while it's running. The toast also signals that
	// the user should start a NEW chat — sessions open before Aria
	// activated cache their MCP list at session-start and won't pick up
	// our registration mid-session.
	//
	// We register with each detected provider independently. If only Claude
	// Code is installed, we register only with it (and skip Codex without
	// warning). If only Codex is installed, vice versa. If both, both. If
	// neither, surface a clear message so the user knows nothing connected.
	// Join the workbench startup overlay's tracking. The unified
	// post-startup summary toast (in aria-skills) replaces the per-
	// component "Autopipe MCP connected" notification this code used
	// to fire. We still need to track so the overlay holds until
	// registration is settled.
	void (async () => {
		await vscode.commands.executeCommand('aria.startup.beginTracking', 'aria-autopipe-mcp');
		let summary = 'Autopipe MCP — already configured';
		let changed = false;
		let shouldOfferReload = false;
		try {
			const port = await mcpServer!.start();
			console.log(`[aria-autopipe] MCP up on ${port}; detecting AI clients…`);

			const detection = await detectAiProviders();
			const wantClaude = detection.providers.some(p => p.kind === 'claude-code' && p.installed);
			const wantCodex = detection.providers.some(p => p.kind === 'codex' && p.installed);

			if (!wantClaude && !wantCodex) {
				summary = 'Autopipe MCP — no Claude Code or Codex extension installed';
				return;
			}

			let claudeChanged = false;
			let codexChanged = false;
			if (wantClaude) {
				const r = await registerWithClaudeCode(port);
				lastRegistration.claude = { ...r, port };
				claudeChanged = r.changed;
				console.log(`[aria-autopipe] Claude Code: ${r.message}`);
			}
			if (wantCodex) {
				const r = await registerWithCodex(port);
				lastRegistration.codex = { ...r, port };
				codexChanged = r.changed;
				console.log(`[aria-autopipe] Codex: ${r.message}`);
			}

			const failedClients: string[] = [];
			if (wantClaude && !lastRegistration.claude.ok) {
				failedClients.push(`Claude Code (${lastRegistration.claude.message})`);
			}
			if (wantCodex && !lastRegistration.codex.ok) {
				failedClients.push(`Codex (${lastRegistration.codex.message})`);
			}

			// Codex caches MCP servers at extension-activation time (not
			// per-chat), so if the Codex extension activated before our
			// `codex mcp add` finished, the user has to reload the
			// window for Codex to see autopipe.
			const PENDING_RELOAD_KEY = 'aria.autopipe.pendingCodexReload';
			const justReloadedForCodex = context.globalState.get<boolean>(PENDING_RELOAD_KEY, false);
			if (justReloadedForCodex) {
				await context.globalState.update(PENDING_RELOAD_KEY, false);
			}
			const codexAlreadyActive = wantCodex
				&& detection.providers.some(p => p.kind === 'codex' && p.installed && p.active);
			shouldOfferReload = codexAlreadyActive && !justReloadedForCodex && codexChanged;

			changed = claudeChanged || codexChanged;
			if (failedClients.length > 0) {
				summary = `Autopipe MCP partial: ${failedClients.join('; ')}`;
			} else if (changed) {
				summary = 'Autopipe MCP registered';
			} else {
				summary = 'Autopipe MCP — already configured';
			}

			// Codex reload prompt is still its own concern (it asks the
			// user to take an action). We deliberately keep this OUT of
			// the unified summary since it needs a button to be useful.
			if (shouldOfferReload) {
				void vscode.window.showInformationMessage(
					'Autopipe needs Codex to reload to pick up the new MCP. Reload now?',
					'Reload Window',
				).then(async (choice) => {
					if (choice === 'Reload Window') {
						await context.globalState.update(PENDING_RELOAD_KEY, true);
						await vscode.commands.executeCommand('workbench.action.reloadWindow');
					}
				});
			}
		} catch (err) {
			console.error('[aria-autopipe] startup failed', err);
			summary = `Autopipe MCP startup failed: ${(err as Error).message}`;
			changed = false;
		} finally {
			await vscode.commands.executeCommand(
				'aria.startup.markComplete',
				'aria-autopipe-mcp',
				summary,
				changed,
			);
		}
	})();

	context.subscriptions.push(
		vscode.commands.registerCommand('aria.autopipe.getStatus', async (silent?: boolean) => {
			const detection = await detectAiProviders();
			const cfg = config.get();
			const profile = config.activeProfile();
			const status = {
				providers: detection.providers,
				anyAiInstalled: detection.anyInstalled,
				claudeCliInstalled: detection.claudeCliInstalled,
				claudeCliVersion: detection.claudeCliVersion,
				mcpServer: {
					running: mcpServer?.listening ?? false,
					port: mcpServer?.currentPort ?? null,
				},
				registration: {
					claude_code: lastRegistration.claude,
					codex: lastRegistration.codex,
				},
				sshActiveProfile: profile ? `${profile.username}@${profile.host}` : null,
				sshActiveProfileId: cfg.active_ssh_profile_id,
				sshProfiles: cfg.ssh_profiles.map(p => ({
					id: p.id, name: p.name, host: p.host, username: p.username, port: p.port,
				})),
				githubConnected: !!cfg.github?.token,
				githubLogin: cfg.github?.login ?? null,
				uploadMode: cfg.per_pipeline_repo ? 'per-pipeline' as const : 'single' as const,
				uploadRepoName: cfg.github_repo,
			};
			if (!silent) {
				const ai = detection.providers.filter(p => p.installed)
					.map(p => `${p.displayName}${p.active ? '' : ' (inactive)'}`)
					.join(', ') || 'No AI assistant detected';
				const mcp = status.mcpServer.running
					? `MCP: 127.0.0.1:${status.mcpServer.port}`
					: 'MCP: not running';
				const ssh = status.sshActiveProfile ?? 'SSH: no active profile';
				const gh = status.githubConnected ? `GitHub: @${status.githubLogin}` : 'GitHub: not connected';
				vscode.window.showInformationMessage(`Autopipe — ${ai} · ${mcp} · ${ssh} · ${gh}`);
			}
			return status;
		}),
		vscode.commands.registerCommand('aria.autopipe.openHub', () => openHubPanel()),
		vscode.commands.registerCommand('aria.autopipe.openPlugins', () => openPluginsPanel()),
		vscode.commands.registerCommand('aria.autopipe.reregister', async (silent?: boolean) => {
			// Re-runs the auto-register flow for every detected client. The
			// `silent` flag is set when Save Settings calls us internally —
			// that flow already shows its own "Settings saved" toast, so we
			// suppress success notifications here to avoid back-to-back
			// messages. Errors still bubble up so the user knows the wiring
			// didn't land.
			if (!mcpServer || !mcpServer.currentPort) {
				if (!silent) {
					vscode.window.showErrorMessage('Aria MCP server is not running yet.');
				}
				return;
			}
			const port = mcpServer.currentPort;
			const detection = await detectAiProviders();
			const wantClaude = detection.providers.some(p => p.kind === 'claude-code' && p.installed);
			const wantCodex = detection.providers.some(p => p.kind === 'codex' && p.installed);

			if (!wantClaude && !wantCodex) {
				if (!silent) {
					vscode.window.showWarningMessage('No supported AI extension detected. Install the Claude Code or Codex extension to use Autopipe.');
				}
				return;
			}

			const connected: string[] = [];
			const failed: string[] = [];
			if (wantClaude) {
				const r = await registerWithClaudeCode(port);
				lastRegistration.claude = { ...r, port };
				(r.ok ? connected : failed).push(r.ok ? 'Claude Code' : `Claude Code (${r.message})`);
			}
			if (wantCodex) {
				const r = await registerWithCodex(port);
				lastRegistration.codex = { ...r, port };
				(r.ok ? connected : failed).push(r.ok ? 'Codex' : `Codex (${r.message})`);
			}

			if (failed.length === 0) {
				if (!silent) {
					vscode.window.showInformationMessage(`Autopipe MCP registered with ${connected.join(' + ')}.`);
				}
			} else {
				vscode.window.showErrorMessage(`MCP registration failed: ${failed.join('; ')}`);
			}
		}),
	);
}

/**
 * Make sure the default 13 plugins are installed. Skips silently when they
 * already match the latest Hub version; otherwise downloads in the
 * background with a progress notification. Failures are reported but
 * non-fatal: the panel still works, the user can retry from the Plugins
 * tab once it ships, and Aria's other features don't depend on plugins.
 *
 * The reference list (`DEFAULT_PLUGIN_NAMES`) is the canonical 13 viewer
 * plugins the autopipe team ships with — every common bioinformatics
 * file type Aria knows how to render at install time.
 */
async function bootstrapDefaultPlugins(plugins: PluginService, hub: HubApiClient): Promise<void> {
	console.log('[aria-autopipe] bootstrapDefaultPlugins() starting');
	// Snapshot of what's already installed so we can decide between "first
	// run", "incremental update", and "everything good". If every default
	// is installed *and* at the right version we don't even show a toast.
	const installedCount = DEFAULT_PLUGIN_NAMES.filter(n => plugins.isInstalled(n)).length;
	const isFirstRun = installedCount === 0;
	console.log(`[aria-autopipe] bootstrap: installed=${installedCount}/${DEFAULT_PLUGIN_NAMES.length}, isFirstRun=${isFirstRun}`);

	await vscode.window.withProgress(
		{
			location: vscode.ProgressLocation.Notification,
			title: isFirstRun ? 'Autopipe — installing default viewer plugins' : 'Autopipe — checking for plugin updates',
			cancellable: false,
		},
		async (progress) => {
			let lastFraction = 0;
			try {
				const result = await plugins.ensureDefaults(
					() => hub.listPlugins(),
					(msg, fraction) => {
						const increment = Math.max(0, (fraction - lastFraction) * 100);
						lastFraction = fraction;
						progress.report({ message: msg, increment });
					},
				);
				const summaryParts: string[] = [];
				if (result.installed.length) {
					summaryParts.push(`Installed ${result.installed.length}`);
				}
				if (result.updated.length) {
					summaryParts.push(`Updated ${result.updated.length}`);
				}
				if (result.failed.length) {
					summaryParts.push(`${result.failed.length} failed`);
				}
				if (summaryParts.length === 0) {
					// Quiet success — everything was already up to date.
					console.log('[aria-autopipe] default plugins up to date');
					return;
				}
				const msg = `Autopipe plugins — ${summaryParts.join(', ')}.`;
				if (result.failed.length > 0) {
					vscode.window.showWarningMessage(`${msg} See Autopipe panel → Plugins to retry: ${result.failed.map(f => f.name).join(', ')}`);
				} else {
					vscode.window.showInformationMessage(msg);
				}
			} catch (err) {
				console.error('[aria-autopipe] bootstrap failed:', err);
				vscode.window.showWarningMessage(
					`Autopipe plugin setup deferred: ${(err as Error).message}. You can install plugins manually from the Plugins tab once the issue is resolved.`,
				);
			}
		},
	);
}

/**
 * Re-run MCP registration when an AI extension is installed/removed after
 * Aria booted. Only acts on transitions — Claude/Codex newly available
 * gets registered; previously-registered client now uninstalled gets
 * cleaned up. Idempotent because the underlying register/unregister
 * functions remove any prior entry before adding.
 */
let refreshInFlight: Promise<void> | null = null;
async function refreshAiRegistrations(): Promise<void> {
	// Coalesce rapid-fire onDidChange events (extension installs often
	// fire several in quick succession) so we don't spam registration
	// calls.
	if (refreshInFlight) {
		return refreshInFlight;
	}
	refreshInFlight = (async () => {
		try {
			if (!mcpServer || !mcpServer.currentPort) {
				return;
			}
			const port = mcpServer.currentPort;
			const detection = await detectAiProviders();
			const wantClaude = detection.providers.some(p => p.kind === 'claude-code' && p.installed);
			const wantCodex = detection.providers.some(p => p.kind === 'codex' && p.installed);

			const newlyConnected: string[] = [];

			// Claude transition: extension newly available → register.
			if (wantClaude && !lastRegistration.claude.ok) {
				const r = await registerWithClaudeCode(port);
				lastRegistration.claude = { ...r, port };
				if (r.ok) {
					newlyConnected.push('Claude Code');
				}
			} else if (!wantClaude && lastRegistration.claude.ok) {
				// Extension uninstalled — remove the stale entry.
				await unregisterFromClaudeCode();
				lastRegistration.claude = { ok: false, message: 'extension uninstalled', port: null };
			}

			if (wantCodex && !lastRegistration.codex.ok) {
				const r = await registerWithCodex(port);
				lastRegistration.codex = { ...r, port };
				if (r.ok) {
					newlyConnected.push('Codex');
				}
			} else if (!wantCodex && lastRegistration.codex.ok) {
				await unregisterFromCodex();
				lastRegistration.codex = { ok: false, message: 'extension uninstalled', port: null };
			}

			if (newlyConnected.length > 0) {
				vscode.window.showInformationMessage(
					'Autopipe MCP connected. Open a new chat to use it.',
				);
			}
		} catch (err) {
			console.error('[aria-autopipe] refreshAiRegistrations failed:', err);
		}
	})();
	try {
		await refreshInFlight;
	} finally {
		refreshInFlight = null;
	}
}

export async function deactivate(): Promise<void> {
	// Intentionally leave the client registrations in place on shutdown.
	// The next Aria launch validates them by comparing the registered port to
	// the live MCP port and only rewrites when stale — so persisting the entry
	// lets that fast path skip a redundant remove+add (and the "start a new
	// chat" toast) on every restart. A stale entry (port changed while Aria was
	// closed) is self-healed on the next launch; the only lingering case is a
	// full Aria uninstall, which the user can clear with `claude/codex mcp
	// remove autopipe`. (unregisterFromClaudeCode/Codex are still used by
	// refreshAiRegistrations when the Claude/Codex extension itself is removed.)
	if (mcpServer) {
		await mcpServer.stop();
		mcpServer = undefined;
	}
}
