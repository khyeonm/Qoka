/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { detectAiProviders } from './detection/claudeCodeDetector';
import { QokaMcpServer } from './mcp/server';
import { ALL_TOOLS, AUTOPIPE_MCP_INSTRUCTIONS } from './mcp/tools';
import { RUN_TOOLS, RUN_MCP_INSTRUCTIONS } from './mcp/tools/run';
import { registerWithClaudeCode } from './registration/claudeCodeMcp';
import { registerWithCodex } from './registration/codexMcp';
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

let mcpServer: QokaMcpServer | undefined;
// Second MCP server ("qoka-run"): quick one-off code execution on the same
// built-in server. Started + registered alongside autopipe.
let runServer: QokaMcpServer | undefined;
interface ClientRegistration {
	ok: boolean;
	message: string;
	port: number | null;
}
let lastRegistration: { claude: ClientRegistration; codex: ClientRegistration } = {
	claude: { ok: false, message: 'not attempted', port: null },
	codex: { ok: false, message: 'not attempted', port: null },
};
let lastRunRegistration: { claude: ClientRegistration; codex: ClientRegistration } = {
	claude: { ok: false, message: 'not attempted', port: null },
	codex: { ok: false, message: 'not attempted', port: null },
};
// Set at activate(). refreshAiRegistrations needs globalState for the Codex
// reload prompt, and it runs outside activate()'s scope.
let extensionContext: vscode.ExtensionContext | undefined;

export function activate(context: vscode.ExtensionContext): void {
	console.log('[aria-autopipe] activate()');
	extensionContext = context;

	// Wire up the shared service container so MCP tool handlers can reach
	// config / ssh / hub / github without each of them tracking the
	// dependency graph individually.
	const config = new ConfigService(context);

	// Built-in server ("Qoka built-in" Run environment): a WSL2 distro (Windows)
	// or bundled QEMU/vfkit guest (Mac/Linux), exposed to the rest of autopipe as
	// a synthetic SSH profile. Created before the shared container so tool handlers
	// (including qoka-run's run_code) can boot it on demand via `services().vm`.
	const vm = new VMManager(context, config);
	context.subscriptions.push({ dispose: () => vm.dispose() });

	const services = {
		config,
		ssh: new SshService(),
		hub: new HubApiClient(config.get().registry_url),
		github: new GitHubAuthService(),
		plugins: new PluginService(),
		vm,
	};
	setServices(services);

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
			// Fire-and-forget: vm.start() blocks up to 3 min waiting for SSH. The
			// panel polls vm.status() for progress, so don't await it here or the
			// row click that triggers setup appears frozen.
			void vm.start().catch(err => console.error('[aria-autopipe] built-in VM start failed:', err));
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
		// Resource overrides (RAM/CPU) - applied on next VM start.
		vscode.commands.registerCommand('aria.autopipe.vm.setResources', (patch: unknown) =>
			config.setLocalVmResources((patch ?? {}) as { memoryMB?: number; cpus?: number })),
		// Interactive editor invoked by the panel's gear button: simple RAM/CPU
		// inputs, then offer to restart the VM so the change takes effect.
		vscode.commands.registerCommand('aria.autopipe.vm.editResources', async () => {
			const cur = config.get().local_vm;
			// Bound the inputs by THIS computer's real limits (the VM runs locally,
			// so a value above the host crashes it - e.g. vfkit rejects a memory
			// size over VZ's maximum). Show the ceiling so the user knows it, and
			// pre-fill with the current value already clamped to that ceiling.
			const lim = vm.hostLimits();
			const maxGB = Math.max(1, Math.floor(lim.maxMemoryMB / 1024));
			const maxCpus = lim.maxCpus;
			const memGB = await vscode.window.showInputBox({
				title: `Built-in server - Memory in GB (max ${maxGB} on this computer)`,
				value: String(Math.min(maxGB, Math.max(1, Math.round(cur.memoryMB / 1024)))),
				validateInput: v => /^\d+$/.test(v) && +v >= 1 && +v <= maxGB ? undefined : `Whole number of GB (1-${maxGB})`,
			});
			if (memGB === undefined) { return; }
			const cpus = await vscode.window.showInputBox({
				title: `Built-in server - CPU cores (max ${maxCpus} on this computer)`,
				value: String(Math.min(maxCpus, Math.max(1, cur.cpus))),
				validateInput: v => /^\d+$/.test(v) && +v >= 1 && +v <= maxCpus ? undefined : `Whole number of cores (1-${maxCpus})`,
			});
			if (cpus === undefined) { return; }
			await config.setLocalVmResources({ memoryMB: Number(memGB) * 1024, cpus: Number(cpus) });
			if (config.isLocalVmActive()) {
				const restart = await vscode.window.showInformationMessage(
					'Built-in server settings saved. Restart it now to apply?', 'Restart now', 'Later');
				if (restart === 'Restart now') {
					await vm.stop();
					// Fire-and-forget: vm.start() blocks up to 3 min waiting for SSH.
					// Don't await it here or the command appears frozen - the panel
					// polls vm.status() and shows the booting/progress state instead.
					void vm.start().catch(err => console.error('[aria-autopipe] VM restart failed:', err));
				}
			}
		}),
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

	mcpServer = new QokaMcpServer({ name: 'qoka-autopipe', tools: ALL_TOOLS, defaultPort: 3748, instructions: AUTOPIPE_MCP_INSTRUCTIONS });
	// Second MCP: "qoka-run" - quick one-off code execution (run_code) on the SAME
	// built-in server (shared via VMManager). Registered under its own name/port so
	// the AI lists it as a separate server. Port range starts at 3760 to stay clear
	// of autopipe's 3748 fallback band.
	runServer = new QokaMcpServer({ name: 'qoka-run', tools: RUN_TOOLS, defaultPort: 3760, instructions: RUN_MCP_INSTRUCTIONS });
	context.subscriptions.push({ dispose: () => { void runServer?.stop(); } });

	// Boot the MCP server only. Registration with the AI clients is NOT done
	// here: `claude mcp add` is a read-modify-write of ~/.claude.json with no
	// locking, so every Qoka extension registering itself at activate() raced the
	// others and a random subset of the servers survived. The workbench
	// chat-open coordinator now drives registration for all of them, one at a
	// time, through aria.autopipe.reregisterMcp below.
	//
	// We still join the workbench startup overlay's tracking so the overlay holds
	// until the server is listening.
	//
	// Kick the server off before the first await so reregisterMcp can await it
	// even when the workbench calls while we're still in beginTracking. The
	// no-op catch only keeps an early rejection from going unhandled in that
	// window; the real error is reported where the IIFE awaits below.
	const startPromise = mcpServer.start();
	startPromise.catch(() => { /* handled below */ });

	// Start the qoka-run server too. Its registration happens inside
	// refreshAiRegistrations (keyed off runServer.currentPort), same as autopipe.
	const runStartPromise = runServer.start();
	runStartPromise.catch((err) => console.error('[aria-autopipe] qoka-run MCP start failed:', err));

	void (async () => {
		await vscode.commands.executeCommand('aria.startup.beginTracking', 'aria-autopipe-mcp');
		let summary = 'Autopipe MCP - already configured';
		let changed = false;
		try {
			const port = await startPromise;
			console.log(`[aria-autopipe] MCP up on ${port}`);
			summary = `Autopipe MCP up on ${port}`;
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

	// Sole registration entry point: the chat-open coordinator (workbench) calls
	// this when an AI chat opens, serialized across every Qoka MCP, so a provider
	// whose CLI was installed after startup gets registered right when the user
	// goes to use it. Returns true if it newly registered something, so the
	// coordinator can show one "open a new chat" prompt across all Qoka MCPs.
	// Awaits the server start because the coordinator may call before the port
	// is known.
	// Reports this MCP server's { name, port } for the startup coordinator's
	// batch config write (see aria.mcp.applyConfig).
	context.subscriptions.push(
		vscode.commands.registerCommand('aria.autopipe.mcpInfo', async () => {
			try { await startPromise; } catch { return null; }
			const port = mcpServer?.currentPort;
			return typeof port === 'number' ? { name: 'qoka-autopipe', port } : null;
		}),
	);

	// qoka-run's { name, port } for the startup coordinator's batch config write.
	// Reported separately from autopipe because it is a SECOND server on its own
	// port (it shares this process + the VMManager, but registers independently).
	context.subscriptions.push(
		vscode.commands.registerCommand('aria.qokarun.mcpInfo', async () => {
			try { await runStartPromise; } catch { return null; }
			const port = runServer?.currentPort;
			return typeof port === 'number' ? { name: 'qoka-run', port } : null;
		}),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('aria.autopipe.reregisterMcp', async () => {
			// refreshAiRegistrations reads mcpServer.currentPort, which the server
			// itself sets once start() resolves - so awaiting start() here is enough.
			try { await startPromise; } catch { return { changed: false, registered: false }; }
			return refreshAiRegistrations();
		}),
	);

	context.subscriptions.push(
		// Live reachability of the ACTIVE run connection - the SINGLE source of truth
		// shared by the Connections view (green/red dot) and get_workspace_info, so
		// the UI, the actual connection, and what the chat reports always agree.
		vscode.commands.registerCommand('aria.autopipe.connection.probe', async () => {
			if (config.isLocalVmActive()) {
				const ep = config.localVmProfile();
				if (!ep) { return { kind: 'builtin' as const, connected: false }; }
				return { kind: 'builtin' as const, connected: await services.ssh.canConnect(ep, 4000) };
			}
			const p = config.activeProfile();
			if (!p) { return { kind: 'none' as const, connected: false }; }
			return { kind: 'ssh' as const, connected: await services.ssh.canConnect(p, 5000) };
		}),
		// Re-establish the ACTIVE connection: restart the built-in server, or (for an
		// SSH host we don't manage) just re-probe it. Returns the fresh reachability.
		vscode.commands.registerCommand('aria.autopipe.connection.restart', async () => {
			if (config.isLocalVmActive()) {
				try {
					await vm.stop();
					await vm.start();
					const ep = config.localVmProfile();
					return { kind: 'builtin' as const, connected: !!ep && await services.ssh.canConnect(ep, 4000) };
				} catch (e) {
					return { kind: 'builtin' as const, connected: false, error: e instanceof Error ? e.message : String(e) };
				}
			}
			const p = config.activeProfile();
			if (!p) { return { kind: 'none' as const, connected: false }; }
			return { kind: 'ssh' as const, connected: await services.ssh.canConnect(p, 5000) };
		}),
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
				vscode.window.showInformationMessage(`Autopipe - ${ai} · ${mcp} · ${ssh} · ${gh}`);
			}
			return status;
		}),
		vscode.commands.registerCommand('aria.autopipe.openHub', () => openHubPanel()),
		vscode.commands.registerCommand('aria.autopipe.openPlugins', () => openPluginsPanel()),
		vscode.commands.registerCommand('aria.autopipe.reregister', async (silent?: boolean) => {
			// Re-runs the auto-register flow for every detected client. The
			// `silent` flag is set when Save Settings calls us internally -
			// that flow already shows its own "Settings saved" toast, so we
			// suppress success notifications here to avoid back-to-back
			// messages. Errors still bubble up so the user knows the wiring
			// didn't land.
			if (!mcpServer || !mcpServer.currentPort) {
				if (!silent) {
					vscode.window.showErrorMessage('Qoka MCP server is not running yet.');
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
 * tab once it ships, and Qoka's other features don't depend on plugins.
 *
 * The reference list (`DEFAULT_PLUGIN_NAMES`) is the canonical 13 viewer
 * plugins the autopipe team ships with - every common bioinformatics
 * file type Qoka knows how to render at install time.
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
			title: isFirstRun ? 'Autopipe - installing default viewer plugins' : 'Autopipe - checking for plugin updates',
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
					// Quiet success - everything was already up to date.
					console.log('[aria-autopipe] default plugins up to date');
					return;
				}
				const msg = `Autopipe plugins - ${summaryParts.join(', ')}.`;
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
 * Qoka booted. Only acts on transitions - Claude/Codex newly available
 * gets registered; previously-registered client now uninstalled gets
 * cleaned up. Idempotent because the underlying register/unregister
 * functions remove any prior entry before adding.
 */
// Returns true if a provider was NEWLY registered (so the caller can prompt the
// user to open a fresh chat). The self-notification is gone: the chat-open
// coordinator shows a single toast across all Qoka MCPs instead.
/**
 * Codex caches its MCP servers at extension-activation time (not per-chat), so
 * if the Codex extension activated before our `codex mcp add` landed, the user
 * has to reload the window for Codex to see autopipe. Only ask when Codex is
 * actually up and we didn't just reload for this very reason. Deliberately not
 * folded into the unified startup summary: it needs a button to be useful.
 */
const PENDING_CODEX_RELOAD_KEY = 'aria.autopipe.pendingCodexReload';
async function maybeOfferCodexReload(): Promise<void> {
	const context = extensionContext;
	if (!context) {
		return;
	}
	const justReloaded = context.globalState.get<boolean>(PENDING_CODEX_RELOAD_KEY, false);
	if (justReloaded) {
		await context.globalState.update(PENDING_CODEX_RELOAD_KEY, false);
		return;
	}
	const detection = await detectAiProviders();
	const codexActive = detection.providers.some(p => p.kind === 'codex' && p.installed && p.active);
	if (!codexActive) {
		return;
	}
	void vscode.window.showInformationMessage(
		'Autopipe needs Codex to reload to pick up the new MCP. Reload now?',
		'Reload Window',
	).then(async (choice) => {
		if (choice === 'Reload Window') {
			await context.globalState.update(PENDING_CODEX_RELOAD_KEY, true);
			await vscode.commands.executeCommand('workbench.action.reloadWindow');
		}
	});
}

let refreshInFlight: Promise<{ changed: boolean; registered: boolean }> | null = null;
async function refreshAiRegistrations(): Promise<{ changed: boolean; registered: boolean }> {
	// Coalesce rapid-fire onDidChange events (extension installs often
	// fire several in quick succession) so we don't spam registration
	// calls.
	if (refreshInFlight) {
		return refreshInFlight;
	}
	refreshInFlight = (async () => {
		try {
			if (!mcpServer || !mcpServer.currentPort) {
				return { changed: false, registered: false };
			}
			const port = mcpServer.currentPort;

			const newlyConnected: string[] = [];

			// Register on CLI presence, NOT on the provider EXTENSION being installed.
			// The registration helpers resolve the CLI themselves and no-op (ok=false)
			// when it's absent - exactly like every other Qoka MCP. Gating on the
			// extension used to make autopipe the one server that stayed unregistered
			// through onboarding (the CLI is installed at AI-pick time; the extension
			// only later), so it registered a pass behind the other seven.
			if (!lastRegistration.claude.ok) {
				const r = await registerWithClaudeCode(port);
				lastRegistration.claude = { ...r, port };
				if (r.ok) {
					newlyConnected.push('Claude Code');
				}
			}

			if (!lastRegistration.codex.ok) {
				const r = await registerWithCodex(port);
				lastRegistration.codex = { ...r, port };
				if (r.ok) {
					newlyConnected.push('Codex');
					if (r.changed) {
						await maybeOfferCodexReload();
					}
				}
			}

			// qoka-run: the second MCP (quick code execution). Register it under its
			// own name/port so the AI lists it separately from autopipe. Only once it
			// has a live port (it starts concurrently with autopipe at activate()).
			const runPort = runServer?.currentPort;
			if (runPort) {
				if (!lastRunRegistration.claude.ok) {
					const r = await registerWithClaudeCode(runPort, 'qoka-run');
					lastRunRegistration.claude = { ...r, port: runPort };
					if (r.ok) { newlyConnected.push('Claude Code (qoka-run)'); }
				}
				if (!lastRunRegistration.codex.ok) {
					const r = await registerWithCodex(runPort, 'qoka-run');
					lastRunRegistration.codex = { ...r, port: runPort };
					if (r.ok) { newlyConnected.push('Codex (qoka-run)'); }
				}
			}

			return {
				changed: newlyConnected.length > 0,
				registered: lastRegistration.claude.ok || lastRegistration.codex.ok,
			};
		} catch (err) {
			console.error('[aria-autopipe] refreshAiRegistrations failed:', err);
			return { changed: false, registered: false };
		}
	})();
	try {
		return await refreshInFlight;
	} finally {
		refreshInFlight = null;
	}
}

export async function deactivate(): Promise<void> {
	// Intentionally leave the client registrations in place on shutdown.
	// The next Qoka launch validates them by comparing the registered port to
	// the live MCP port and only rewrites when stale - so persisting the entry
	// lets that fast path skip a redundant remove+add (and the "start a new
	// chat" toast) on every restart. A stale entry (port changed while Qoka was
	// closed) is self-healed on the next launch; the only lingering case is a
	// full Qoka uninstall, which the user can clear with `claude/codex mcp
	// remove autopipe`. (unregisterFromClaudeCode/Codex are still used by
	// refreshAiRegistrations when the Claude/Codex extension itself is removed.)
	if (mcpServer) {
		await mcpServer.stop();
		mcpServer = undefined;
	}
}
