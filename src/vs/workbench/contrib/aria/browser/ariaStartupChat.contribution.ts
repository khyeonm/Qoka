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
 *      present the moment Aria opens.
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

		// Make sure the CLI for each chosen provider is installed - the chat panel
		// and background features are CLI-backed, so this is needed even when the
		// provider's Marketplace extension is already present (no pending install).
		// Independent of MCP setup: it only needs aria-skills active (it activates
		// it directly), so a slow/failed MCP boot can't block the CLI install.
		void this._ensureProviderClis();

		// Ensure every Aria MCP is registered with the installed provider(s), and
		// keep it correct when a provider is installed later. One coordinated
		// "open a new chat" toast across all Aria MCPs (not one per server).
		this._wireMcpReconcile();

		// Cover the window IMMEDIATELY (synchronously, at window load) so the bare
		// workbench never flashes, then decide once we can read the live state.
		const hideLoading = this._showLoadingOverlay('Preparing Aria…');
		// Drain the stale one-shot; the decision below is made from LIVE state.
		takePendingInstall();
		void (async () => {
			// Surface any provider EXTENSION the user opted into (via aria.aiProvider)
			// that isn't installed - checked LIVE every launch, not from the one-shot
			// pending list. This re-appears on re-entry (e.g. a bounce back into the
			// picker) and correctly covers "auto" (both providers). Open the
			// Extensions view over the missing ids and reveal a chat once installed.
			const missing = await this._missingProviderExtensions();
			if (missing.length > 0) {
				const labels = missing.map(p => PROVIDER_LABEL[p]).join(' and ');
				const ids = missing.map(p => PROVIDER_EXTENSION_ID[p]);
				try { await this.commandService.executeCommand('workbench.extensions.action.showExtensionsWithIds', ids); } catch { /* ignore */ }
				await timeout(2500); // let the Marketplace list populate behind the overlay
				hideLoading();
				this.notificationService.info(`Install ${labels} to finish setting up your AI assistant.`);
				this._revealWhenInstalled(missing);
				return;
			}

			// Hold the loading screen until Aria is actually usable: every MCP server
			// is up (whenAriaSetupReady), the installed provider's CLI is present, and
			// ALL eight MCPs are registered (reconcile UNTIL SETTLED, so a server that
			// starts a beat late still lands before the loading clears - no more
			// "autopipe connects after a reload"). One silent pass-set, then done - no
			// scattered delayed passes spamming the console after the picker opens.
			// Failsafe timeout so a stuck install can't trap the user on the loader.
			await Promise.race([
				(async () => {
					await this._ensureClisForInstalledProviders();
					await Promise.race([whenAriaSetupReady(), timeout(30000)]);
					await this._reconcileUntilSettled();
				})(),
				timeout(60000),
			]);
			hideLoading();
			if (!hasPickedAiProvider()) {
				return;
			}
			// Retry: a just-activated provider (e.g. after a post-install reload)
			// may register its reveal command a moment after we ask.
			void revealAiProviderChat(this.commandService, this.configurationService, { retryMs: 6000 });
		})();
	}

	/** Every Aria MCP extension exposes this command: re-run its registration
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

	/** Ask every Aria MCP to (re)register; show ONE toast if any newly did. A
	 *  command that isn't registered yet (its extension not active) just resolves
	 *  to false. Registration is done via each provider's CLI, so the config
	 *  schema is always correct - we never hand-write ~/.claude.json / config.toml. */
	private async _reconcileMcp(silent = false): Promise<boolean> {
		// SEQUENTIAL, not Promise.all: each reregister shells out to `claude mcp
		// add`/`codex mcp add`, which read-modify-write the SAME ~/.claude.json /
		// config.toml. Running them concurrently caused lost updates - two adds read
		// the same file and the later write clobbered the earlier one, so a random
		// one of the eight servers (autopipe, paper, …) would silently go missing
		// (7 of 8 connected). Awaiting each in turn serialises the file writes.
		let anyChanged = false;
		for (const cmd of this._mcpReregisterCommands) {
			const changed = await Promise.resolve(this.commandService.executeCommand<boolean>(cmd)).then(r => r === true, () => false);
			anyChanged = anyChanged || changed;
		}
		// `silent` suppresses the toast during onboarding / first-run setup (the user
		// hasn't opened a chat yet, so "open a NEW chat" would be premature).
		if (anyChanged && !silent) {
			this.notificationService.info('Aria tools connected. Open a NEW Claude or Codex chat to use them.');
		}
		return anyChanged;
	}

	/** Reconcile repeatedly until a pass registers nothing new (every server has
	 *  settled) or the pass cap is hit. Covers a server that starts a beat after the
	 *  others, so a single caller (the loading page) can hold until ALL eight MCPs
	 *  are actually registered instead of relying on scattered delayed passes.
	 *  Always silent - the loading page is the user-facing signal. Returns whether
	 *  anything registered across all passes. */
	private async _reconcileUntilSettled(maxPasses = 5): Promise<boolean> {
		let everChanged = false;
		for (let i = 0; i < maxPasses; i++) {
			const changed = await this._reconcileMcp(true);
			everChanged = everChanged || changed;
			if (!changed) {
				break;   // a pass that registered nothing new → settled
			}
			await timeout(1000);
		}
		return everChanged;
	}

	/** Install the CLI for the given chosen providers, wait for the Aria MCP
	 *  servers to be up, then register them until settled - all idempotent. Called
	 *  by the overlay's AI picker (via aria.setup.prepareProviders) so the loading
	 *  page can hold until every tool is actually registered. */
	private async _prepareProviders(providers: unknown[]): Promise<void> {
		const chosen = providers.filter((p): p is ConcreteProvider => p === 'claude' || p === 'codex');
		// aria-skills owns installProviderCli; make sure it's active first (a
		// dynamically-registered command won't auto-activate its extension).
		try { await this.extensionService.activateByEvent('onStartupFinished'); } catch { /* ignore */ }
		for (const p of chosen) {
			try { await this.commandService.executeCommand('aria.provider.installCli', p); } catch { /* ignore */ }
		}
		// Hold until the MCP servers have started (so registration has something to
		// register), with a failsafe so a stuck server can't trap onboarding.
		await Promise.race([whenAriaSetupReady(), timeout(30000)]);
		await this._reconcileUntilSettled();
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
	 *  is where the "Aria tools connected. Open a NEW chat" toast belongs, since a
	 *  chat may already be open. First-run setup goes through the loading gate,
	 *  which is silent. */
	private _wireMcpReconcile(): void {
		this._register(this.extensionService.onDidChangeExtensions(() => {
			void (async () => {
				await this._ensureClisForInstalledProviders();
				await this._reconcileMcp(false);
			})();
		}));
	}

	/** Auto-install the CLI for each provider the user chose (from the
	 *  `aria.aiProvider` setting). `auto` means they picked both, so ensure both.
	 *  The command no-ops when a CLI is already present and only installs after
	 *  the user has been through the picker. */
	private async _ensureProviderClis(): Promise<void> {
		const picked = hasPickedAiProvider();
		const pref = this.configurationService.getValue<string>(ARIA_AI_PROVIDER_SETTING) ?? 'auto';
		console.log(`[aria] ensureProviderClis: picked=${picked}, aria.aiProvider=${pref}`);
		if (!picked) {
			return;
		}
		// "Opt-in" set (NOT preference order): an explicit choice installs only that
		// one; `auto` means the user picked both, so ensure both.
		const chosen: ConcreteProvider[] = pref === 'claude' || pref === 'codex' ? [pref] : [...ARIA_ALL_PROVIDERS];
		// The install command lives in aria-skills; make sure it's active before we
		// call it (executeCommand won't auto-activate a dynamically-registered
		// command). activateByEvent is idempotent if it already fired.
		try { await this.extensionService.activateByEvent('onStartupFinished'); } catch { /* ignore */ }
		for (const p of chosen) {
			try {
				console.log(`[aria] ensureProviderClis: requesting CLI install for ${p}`);
				await this.commandService.executeCommand('aria.provider.installCli', p);
			} catch (e) {
				console.log(`[aria] ensureProviderClis: install command failed for ${p}:`, e);
			}
		}
		// Install only - registration is the loading gate's single reconcile pass
		// (below), so the project window doesn't reconcile twice. Onboarding already
		// registered everything via aria.setup.prepareProviders, so at project open
		// the gate's pass is a quick "already registered" verify.
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
