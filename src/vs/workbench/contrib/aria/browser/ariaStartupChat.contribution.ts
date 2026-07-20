/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IWorkbenchContribution, IWorkbenchContributionsRegistry, Extensions as WorkbenchExtensions } from '../../../common/contributions.js';
import { LifecyclePhase } from '../../../services/lifecycle/common/lifecycle.js';
import { CommandsRegistry, ICommandService } from '../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IWorkspaceContextService, WorkbenchState } from '../../../../platform/workspace/common/workspace.js';
import { IExtensionService } from '../../../services/extensions/common/extensions.js';
import { IWorkbenchLayoutService, Parts } from '../../../services/layout/browser/layoutService.js';
import { timeout } from '../../../../base/common/async.js';
import { revealAiProviderChat } from './aiProviderChat.js';
import { whenAriaSetupReady } from './ariaSetupReady.js';
import { ConcreteProvider, hasPickedAiProvider, takePendingInstall, PROVIDER_EXTENSION_ID, PROVIDER_LABEL } from './ariaAiProviderChoice.js';
import { ARIA_AI_PROVIDER_SETTING, ARIA_ALL_PROVIDERS } from '../common/ariaConfiguration.js';

/**
 * On startup in a project window:
 *   1. If the user chose an assistant they hadn't installed yet (deferred from
 *      the AI picker), open its Marketplace page(s) HERE - now that a real
 *      project window exists - so they can install, then reload. We don't also
 *      reveal the chat that run (they're installing).
 *   2. Otherwise auto-open the chosen provider's chat so the chat surface is
 *      present the moment Qoka opens.
 *
 * Sequencing:
 *   - EMPTY workbench (no folder): skip. The Started overlay owns the screen.
 *   - First run before a project is picked: skip - nothing to do until a
 *     project window exists.
 *   - Provider installed but signed out: revealing shows its own login screen
 *     (the natural place to sign in); nothing installed and no pending install
 *     → reveal is a no-op.
 */
class AriaStartupChatContribution extends Disposable implements IWorkbenchContribution {

	constructor(
		@ICommandService private readonly commandService: ICommandService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@INotificationService private readonly notificationService: INotificationService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@IExtensionService private readonly extensionService: IExtensionService,
		@IWorkbenchLayoutService private readonly layoutService: IWorkbenchLayoutService,
	) {
		super();

		// Registered in EVERY window (including the empty picker where the overlay's
		// AI picker lives), so it must come BEFORE the empty-workbench early return.
		// The overlay calls this the moment the user clicks Continue on the AI
		// picker: install the chosen provider's CLI and register the MCP servers
		// while a loading page is shown, so by the time the loading clears the tools
		// are ready. Idempotent - a relaunch (CLI already installed, MCPs already
		// registered) returns almost immediately.
		this._register(CommandsRegistry.registerCommand('aria.setup.prepareProviders', (_acc, providers) =>
			this._prepareProviders(Array.isArray(providers) ? providers : [])));

		if (this.workspaceContextService.getWorkbenchState() === WorkbenchState.EMPTY) {
			return;
		}

		// Keep the right-hand chat panel (auxiliary bar) pinned open in every
		// project window, even before any assistant is installed - the chat
		// surface should always be present, and a just-installed provider's chat
		// then appears in that same spot instead of the panel popping in later.
		try { this.layoutService.setPartHidden(false, Parts.AUXILIARYBAR_PART); } catch { /* layout not ready */ }

		// CLI install + MCP registration happen INSIDE the first-run gate below (it
		// awaits the CLI install, then holds the loader until every server reports it
		// is registered). This listener only keeps registration correct when a
		// provider is added LATER, after that gate has completed.
		this._wireMcpReconcile();

		// Cover the window IMMEDIATELY (synchronously, at window load) so the bare
		// workbench never flashes, then decide once we can read the live state.
		const hideLoading = this._showLoadingOverlay('Preparing Qoka…');
		// Drain the stale one-shot; the decision below is made from LIVE state.
		takePendingInstall();
		void (async () => {
			// No provider chosen yet → nothing to set up (shouldn't happen in a
			// project window, but guard so we never hold an empty loader).
			if (!hasPickedAiProvider()) {
				this._setupGateDone = true;
				hideLoading();
				return;
			}

			const chosen = this._chosenProviders();

			// 1+2) Install the CLI for each chosen provider (AWAIT real completion,
			//    retry ONCE on failure), then verify it is actually present. MCP
			//    registration needs only the CLI - NOT the provider's VS Code chat
			//    extension. So we never auto-install or wait on that extension: the
			//    user can install it whenever, and it will read the config we write
			//    here and see every tool immediately (no "open a new chat" dance).
			//    "install finished but the CLI is still absent (after one retry)" is a
			//    real FAILURE signal - so a failed install (e.g. offline) ends the wait
			//    instead of spinning forever, and is surfaced when the loader clears.
			try { await this.extensionService.activateByEvent('onStartupFinished'); } catch { /* ignore */ }
			const results = await Promise.all(chosen.map(p => this._installAndVerifyCli(p)));
			const usable = chosen.filter((_, i) => results[i]);
			const failed = chosen.filter((_, i) => !results[i]);

			if (usable.length === 0) {
				this._setupGateDone = true;
				hideLoading();
				this.notificationService.warn('Qoka could not set up the AI command-line tool. Check your internet connection, then reload the window to retry.');
				return;
			}

			// 3) Wait for the MCP servers to come up, then register every Qoka MCP
			//    with the usable provider CLI(s) and HOLD the loader until they ALL
			//    report registered - a real completion signal (registeredCount), not a
			//    timer. MCP ports are per-window, so THIS project window's registration
			//    is the one that counts. Because both chosen CLIs are confirmed present
			//    above, one reconcile registers every server with each - so "all 9
			//    registered" also means "with every chosen provider".
			await Promise.race([whenAriaSetupReady(), timeout(30000)]);
			const allRegistered = await this._registerMcpFast(usable);
			this._setupGateDone = true;
			hideLoading();

			if (failed.length > 0) {
				const labels = failed.map(p => PROVIDER_LABEL[p]).join(' and ');
				this.notificationService.warn(`Couldn't set up ${labels}. The other AI tools are ready; reload the window later to retry ${labels}.`);
			} else if (!allRegistered) {
				this.notificationService.warn('Some Qoka tools could not connect. Reload the window to retry.');
			}

			// If the chosen provider's chat EXTENSION isn't installed yet, open the
			// Marketplace pre-filtered to it so the user can install it in one click -
			// no nag, no blocking. Every MCP tool is already registered, so the chat
			// lights up with all of them the moment the extension finishes installing
			// (_revealWhenInstalled watches for that). If the extension is already
			// present, just reveal the chat now.
			const missingExtensions = await this._missingProviderExtensions();
			if (missingExtensions.length > 0) {
				const ids = missingExtensions.map(p => PROVIDER_EXTENSION_ID[p]);
				try { await this.commandService.executeCommand('workbench.extensions.action.showExtensionsWithIds', ids); } catch { /* ignore */ }
				this._revealWhenInstalled(missingExtensions);
			} else {
				void revealAiProviderChat(this.commandService, this.configurationService, { retryMs: 6000 });
			}
		})();
	}

	/** Set once the first-run setup gate has finished (CLIs installed + every MCP
	 *  registered). Until then, the onDidChangeExtensions listener stays quiet so it
	 *  can't reconcile concurrently with the gate or fire a premature toast. */
	private _setupGateDone = false;

	/** Every Qoka MCP extension exposes this command: re-run its registration
	 *  with whatever provider CLIs are present, returning true if it NEWLY
	 *  registered something. Firing all of them and OR-ing the results lets us
	 *  show a single "open a new chat" prompt. */
	private readonly _mcpReregisterCommands = [
		'aria.autopipe.reregisterMcp',
		'aria.paper.reregisterMcp',
		'aria.paperSearch.reregisterMcp',
		'aria.memory.reregisterMcp',
		'aria.notes.reregisterMcp',
		'aria.roadmap.reregisterMcp',
		'aria.methodsSearch.reregisterMcp',
		'aria.hypothesis.reregisterMcp',
		'aria.overview.reregisterMcp',
	];

	/** Each Qoka MCP extension also exposes this: returns { name, port } for its
	 *  live server (or null if not up). The coordinator collects all of them and
	 *  registers every server in ONE batched config write - far faster than the
	 *  per-server CLI path (which is kept as the fallback). */
	private readonly _mcpInfoCommands = [
		'aria.autopipe.mcpInfo',
		'aria.paper.mcpInfo',
		'aria.paperSearch.mcpInfo',
		'aria.memory.mcpInfo',
		'aria.notes.mcpInfo',
		'aria.roadmap.mcpInfo',
		'aria.methodsSearch.mcpInfo',
		'aria.hypothesis.mcpInfo',
		'aria.overview.mcpInfo',
	];

	/**
	 * Fast MCP registration. Collect every server's { name, port } (parallel reads
	 * are race-free), then write BOTH provider config files in one batched,
	 * single-writer call (aria.mcp.applyConfig) - which also verifies and CLI-
	 * retries stragglers. Because the writer is verify-first, a relaunch whose
	 * ports are unchanged is a near-instant no-op. Falls back to the original
	 * per-extension CLI reconcile if the fast path can't confirm every server, so
	 * registration is never worse than before.
	 */
	private async _registerMcpFast(providers: ConcreteProvider[]): Promise<boolean> {
		try {
			const infos = await Promise.all(this._mcpInfoCommands.map(cmd =>
				Promise.resolve(this.commandService.executeCommand<unknown>(cmd)).then(r => r, () => undefined)));
			const servers = infos.filter((r): r is { name: string; port: number } =>
				!!r && typeof r === 'object'
				&& typeof (r as { name?: unknown }).name === 'string'
				&& typeof (r as { port?: unknown }).port === 'number');
			// Only trust the fast path when every server reported; otherwise fall
			// back so a straggler that hasn't bound yet still gets registered.
			if (servers.length === this._mcpInfoCommands.length) {
				const res = await this.commandService.executeCommand<{ allRegistered?: boolean }>(
					'aria.mcp.applyConfig', { providers, servers });
				if (res && res.allRegistered === true) {
					return true;
				}
			}
		} catch {
			// fall through to the CLI reconcile path
		}
		return this._registerRemainingMcp();
	}

	/** Ask every Qoka MCP to (re)register; show ONE toast if any newly did. A
	 *  command that isn't registered yet (its extension not active) just resolves
	 *  to false. Registration is done via each provider's CLI, so the config
	 *  schema is always correct - we never hand-write ~/.claude.json / config.toml. */
	private async _reconcileMcp(silent = false): Promise<{ anyChanged: boolean; registeredCount: number }> {
		// SEQUENTIAL, not Promise.all: each reregister shells out to `claude mcp
		// add`/`codex mcp add`, which read-modify-write the SAME ~/.claude.json /
		// config.toml. Running them concurrently caused lost updates - two adds read
		// the same file and the later write clobbered the earlier one, so a random
		// one of the eight servers (autopipe, paper, …) would silently go missing
		// (7 of 8 connected). Awaiting each in turn serialises the file writes.
		let anyChanged = false;
		let registeredCount = 0;
		for (const cmd of this._mcpReregisterCommands) {
			// Each reregister returns { changed, registered } (registered = the server
			// is present in >= 1 provider CLI's config after this call). Tolerate the
			// legacy bare-boolean shape too, where `true` meant "newly registered".
			const res = await Promise.resolve(this.commandService.executeCommand<unknown>(cmd)).then(r => r, () => undefined);
			if (res && typeof res === 'object') {
				const o = res as { changed?: boolean; registered?: boolean };
				if (o.changed) { anyChanged = true; }
				if (o.registered) { registeredCount++; }
			} else if (res === true) {
				anyChanged = true;
				registeredCount++;
			}
		}
		// `silent` suppresses the toast during onboarding / first-run setup (the user
		// hasn't opened a chat yet, so "open a NEW chat" would be premature).
		if (anyChanged && !silent) {
			this.notificationService.info('Qoka tools connected. Open a NEW Claude or Codex chat to use them.');
		}
		return { anyChanged, registeredCount };
	}

	/**
	 * Register every Qoka MCP server, retrying ONLY the ones not yet registered.
	 * The pending set draining to empty is the real COMPLETION signal - the loader
	 * holds until then. Retrying just the stragglers avoids re-spawning a `mcp add`/
	 * `mcp get` for the servers already done (each is a process on Windows).
	 *
	 * Bounded to `maxPasses` attempts (1 initial + retries): the CLIs are verified
	 * present before this runs, so registration should succeed almost immediately;
	 * a straggler is retried a few times to ride out a transient config-write race
	 * or a server that started a beat late. If some still don't register after that,
	 * we return false and the caller surfaces a warning (the app stays usable, and
	 * onDidChangeExtensions / a reload will pick them up) rather than spinning
	 * forever. Returns true iff every server registered.
	 */
	private async _registerRemainingMcp(maxPasses = 4): Promise<boolean> {
		const pending = new Set(this._mcpReregisterCommands);
		for (let pass = 0; pass < maxPasses; pass++) {
			// SEQUENTIAL: each reregister is a read-modify-write of the shared
			// ~/.claude.json, so awaiting one at a time serialises the file writes.
			for (const cmd of [...pending]) {
				const res = await Promise.resolve(this.commandService.executeCommand<unknown>(cmd)).then(r => r, () => undefined);
				const registered = (res && typeof res === 'object' && (res as { registered?: boolean }).registered === true) || res === true;
				if (registered) { pending.delete(cmd); }
			}
			if (pending.size === 0) { return true; }
			// Give a slow-to-start server a beat before the next retry (not after the
			// final attempt).
			if (pass < maxPasses - 1) { await timeout(1500); }
		}
		return pending.size === 0;
	}

	/** Install the CLI for the given chosen providers. Called by the overlay's AI
	 *  picker (via aria.setup.prepareProviders) so the loading page holds until the
	 *  CLIs are installed.
	 *
	 *  Note: this runs in the EMPTY window. It deliberately does NOT register the
	 *  MCP servers - picking a project reloads into a new window where every Qoka
	 *  MCP server gets a FRESH port, so any registration here is immediately stale.
	 *  Only the CLI install (a persistent binary) is worth doing now; the project
	 *  window is where registration happens, and its loader holds until all servers
	 *  are actually registered. */
	private async _prepareProviders(providers: unknown[]): Promise<void> {
		const chosen = providers.filter((p): p is ConcreteProvider => p === 'claude' || p === 'codex');
		// aria-skills owns installProviderCli; make sure it's active first (a
		// dynamically-registered command won't auto-activate its extension).
		try { await this.extensionService.activateByEvent('onStartupFinished'); } catch { /* ignore */ }
		for (const p of chosen) {
			try { await this.commandService.executeCommand('aria.provider.installCli', p); } catch { /* ignore */ }
		}
	}

	/** Install the CLI for every provider whose EXTENSION is installed, then
	 *  reconcile. Keyed off the installed extension (reliably detectable), NOT the
	 *  "picked" localStorage flag (which can be missing). Covers onboarding (the
	 *  user installs the chosen provider's extension, which we then back with its
	 *  CLI) AND a provider added later from Settings or the Marketplace. installCli
	 *  is idempotent. We do NOT install a CLI for a provider the user never added,
	 *  so a Claude-only user never downloads Codex + a portable Node. */
	private async _ensureClisForInstalledProviders(): Promise<void> {
		// aria-skills owns the install command; make sure it's active or the
		// executeCommand below is a no-op (dynamically-registered commands don't
		// auto-activate their extension).
		try { await this.extensionService.activateByEvent('onStartupFinished'); } catch { /* ignore */ }
		for (const p of ARIA_ALL_PROVIDERS) {
			if (await this.extensionService.getExtension(PROVIDER_EXTENSION_ID[p])) {
				try { await this.commandService.executeCommand('aria.provider.installCli', p); } catch { /* ignore */ }
			}
		}
		// NOTE: install only. Registration is driven by the caller so each context
		// picks the right pass: the loading gate reconciles UNTIL SETTLED (silently),
		// while a provider added LATER reconciles once and shows the "open a new
		// chat" toast.
	}

	/** When the installed extension set changes (a provider added later from the
	 *  Marketplace / Settings), install its CLI if needed and register once - this
	 *  is where the "Qoka tools connected. Open a NEW chat" toast belongs, since a
	 *  chat may already be open. First-run setup goes through the loading gate,
	 *  which is silent. */
	private _wireMcpReconcile(): void {
		this._register(this.extensionService.onDidChangeExtensions(() => {
			// The first-run gate owns registration during setup; only handle provider
			// changes AFTER it completes, so the two don't reconcile concurrently
			// (concurrent `mcp add` clobber each other) and so no toast fires mid-setup.
			if (!this._setupGateDone) { return; }
			void (async () => {
				await this._ensureClisForInstalledProviders();
				await this._reconcileMcp(false);
			})();
		}));
	}

	/** The providers the user chose, from the `aria.aiProvider` setting. An explicit
	 *  choice = that one; `auto` = both. */
	private _chosenProviders(): ConcreteProvider[] {
		const pref = this.configurationService.getValue<string>(ARIA_AI_PROVIDER_SETTING) ?? 'auto';
		return pref === 'claude' || pref === 'codex' ? [pref] : [...ARIA_ALL_PROVIDERS];
	}

	/** True when the provider's command-line tool is present on PATH / known dirs.
	 *  Uses the CLI-availability probe aria-paper exposes; false if it can't tell. */
	private async _cliAvailable(provider: ConcreteProvider): Promise<boolean> {
		const cmd = provider === 'claude' ? 'aria.peerReview.claudeAvailable' : 'aria.peerReview.codexAvailable';
		try {
			return (await this.commandService.executeCommand<boolean>(cmd)) === true;
		} catch {
			return false;
		}
	}

	/** Install one provider's CLI and confirm it landed, retrying ONCE on failure.
	 *  installProviderCli clears its per-session guard when an install fails, so the
	 *  second call genuinely re-runs. Returns whether the CLI is present afterwards. */
	private async _installAndVerifyCli(provider: ConcreteProvider): Promise<boolean> {
		for (let attempt = 0; attempt < 2; attempt++) {
			try { await this.commandService.executeCommand('aria.provider.installCli', provider); } catch { /* reported below via availability */ }
			if (await this._cliAvailable(provider)) { return true; }
		}
		return false;
	}

	/** The provider EXTENSIONS the user opted into (via aria.aiProvider: an
	 *  explicit choice = that one; `auto` = both) that are NOT installed. Read live
	 *  so a missing provider is always surfaced, not just once from the picker. */
	private async _missingProviderExtensions(): Promise<ConcreteProvider[]> {
		if (!hasPickedAiProvider()) {
			return [];
		}
		const pref = this.configurationService.getValue<string>(ARIA_AI_PROVIDER_SETTING) ?? 'auto';
		const wanted: ConcreteProvider[] = pref === 'claude' || pref === 'codex' ? [pref] : [...ARIA_ALL_PROVIDERS];
		try { await this.extensionService.activateByEvent('onStartupFinished'); } catch { /* ignore */ }
		const missing: ConcreteProvider[] = [];
		for (const p of wanted) {
			if (!(await this.extensionService.getExtension(PROVIDER_EXTENSION_ID[p]))) {
				missing.push(p);
			}
		}
		return missing;
	}

	/** Full-viewport loading page shown while the Extensions install view opens
	 *  and loads. Returns a function that fades it out and removes it. */
	private _showLoadingOverlay(title: string): () => void {
		const overlay = document.createElement('div');
		overlay.id = 'aria-install-loading-overlay';
		Object.assign(overlay.style, {
			position: 'fixed', inset: '0', zIndex: '999997',
			display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '22px',
			background: 'rgba(0, 0, 0, 0.72)', backdropFilter: 'blur(2px)',
			color: '#fff', fontFamily: 'var(--vscode-font-family, system-ui, sans-serif)',
			opacity: '0', transition: 'opacity 160ms ease-in', cursor: 'wait',
		});
		(overlay.style as unknown as Record<string, string>).webkitBackdropFilter = 'blur(2px)';
		// Keep the window draggable by the title-bar region while this full-screen
		// overlay is up (the first-run overlay used to provide this; it no longer
		// shows, so carry the behavior here).
		(overlay.style as unknown as Record<string, string>).webkitAppRegion = 'drag';

		if (!document.getElementById('aria-install-spin-kf')) {
			const style = document.createElement('style');
			style.id = 'aria-install-spin-kf';
			style.textContent = '@keyframes aria-install-spin { to { transform: rotate(360deg); } }';
			document.head.appendChild(style);
		}

		const spinner = document.createElement('div');
		Object.assign(spinner.style, {
			width: '44px', height: '44px', borderRadius: '50%',
			border: '3px solid rgba(255, 255, 255, 0.2)', borderTopColor: '#fff',
			animation: 'aria-install-spin 1.1s linear infinite',
		});
		overlay.appendChild(spinner);

		const text = document.createElement('div');
		text.textContent = title;
		Object.assign(text.style, { fontSize: '14px', opacity: '0.9' });
		overlay.appendChild(text);

		document.body.appendChild(overlay);
		requestAnimationFrame(() => { overlay.style.opacity = '1'; });

		return () => {
			overlay.style.opacity = '0';
			setTimeout(() => overlay.remove(), 200);
		};
	}

	/** Reveal the provider chat as soon as one of `providers` becomes installed
	 *  (covers installs that activate without a full reload). */
	private _revealWhenInstalled(providers: ConcreteProvider[]): void {
		const anyInstalled = async (): Promise<boolean> => {
			for (const p of providers) {
				if (await this.extensionService.getExtension(PROVIDER_EXTENSION_ID[p])) {
					return true;
				}
			}
			return false;
		};
		const sub = this.extensionService.onDidChangeExtensions(async () => {
			if (await anyInstalled()) {
				sub.dispose();
				await revealAiProviderChat(this.commandService, this.configurationService, { retryMs: 8000 });
			}
		});
		this._register(sub);
	}
}

Registry.as<IWorkbenchContributionsRegistry>(WorkbenchExtensions.Workbench)
	.registerWorkbenchContribution(AriaStartupChatContribution, LifecyclePhase.Restored);
