/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IWorkbenchContribution, IWorkbenchContributionsRegistry, Extensions as WorkbenchExtensions } from '../../../common/contributions.js';
import { LifecyclePhase } from '../../../services/lifecycle/common/lifecycle.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IWorkspaceContextService, WorkbenchState } from '../../../../platform/workspace/common/workspace.js';
import { IExtensionService } from '../../../services/extensions/common/extensions.js';
import { timeout } from '../../../../base/common/async.js';
import { revealAiProviderChat } from './aiProviderChat.js';
import { whenAriaSetupReady } from './ariaSetupReady.js';
import { ConcreteProvider, hasPickedAiProvider, takePendingInstall, PROVIDER_EXTENSION_ID, PROVIDER_LABEL } from './ariaAiProviderChoice.js';
import { ARIA_AI_PROVIDER_SETTING, ARIA_ALL_PROVIDERS } from '../common/ariaConfiguration.js';

/**
 * On startup in a project window:
 *   1. If the user chose an assistant they hadn't installed yet (deferred from
 *      the AI picker), open its Marketplace page(s) HERE — now that a real
 *      project window exists — so they can install, then reload. We don't also
 *      reveal the chat that run (they're installing).
 *   2. Otherwise auto-open the chosen provider's chat so the chat surface is
 *      present the moment Aria opens.
 *
 * Sequencing:
 *   - EMPTY workbench (no folder): skip. The Started overlay owns the screen.
 *   - First run before a project is picked: skip — nothing to do until a
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
	) {
		super();

		if (this.workspaceContextService.getWorkbenchState() === WorkbenchState.EMPTY) {
			return;
		}

		// Make sure the CLI for each chosen provider is installed — the chat panel
		// and background features are CLI-backed, so this is needed even when the
		// provider's Marketplace extension is already present (no pending install).
		// Independent of MCP setup: it only needs aria-skills active (it activates
		// it directly), so a slow/failed MCP boot can't block the CLI install.
		void this._ensureProviderClis();

		// Deferred installs: the user chose provider(s) they hadn't installed. A
		// real project window now exists. Cover it with a loading page IMMEDIATELY
		// (synchronously, at window load) so the bare workbench never shows first,
		// then open both providers in the Extensions view (one search over both
		// ids — separate `extension.open` detail tabs replace each other), and
		// reveal it once the Marketplace list has had time to load. We do NOT wait
		// for whenAriaSetupReady here: the Extensions/Marketplace view doesn't need
		// Aria's MCP setup, and waiting would leave the workbench visible first.
		const pending = takePendingInstall();
		if (pending.length > 0) {
			const labels = pending.map(p => PROVIDER_LABEL[p]).join(' and ');
			const hideLoading = this._showLoadingOverlay(`Opening the install page for ${labels}…`);
			void (async () => {
				const ids = pending.map(p => PROVIDER_EXTENSION_ID[p]);
				try { await this.commandService.executeCommand('workbench.extensions.action.showExtensionsWithIds', ids); } catch { /* ignore */ }
				await timeout(2500); // let the Marketplace list populate behind the overlay
				hideLoading();
				this.notificationService.info(`Install ${labels}, then reload Aria to finish setup.`);
				// As soon as one of them is installed (with or without a reload),
				// reveal its chat so the tab is active right after install.
				this._revealWhenInstalled(pending);
			})();
			return;
		}

		// No pending install → cover the window with a loading screen until Aria is
		// actually usable (its MCP servers are up), in ALL modes, so the user never
		// interacts with a half-ready app. A failsafe timeout hides it even if setup
		// stalls, so a broken MCP boot can't trap the user on the loading screen.
		const hideLoading = this._showLoadingOverlay('Preparing Aria…');
		const SETUP_FAILSAFE_MS = 30000;
		void Promise.race([whenAriaSetupReady(), timeout(SETUP_FAILSAFE_MS)]).then(() => {
			hideLoading();
			if (!hasPickedAiProvider()) {
				return;
			}
			// Retry: a just-activated provider (e.g. after a post-install reload)
			// may register its reveal command a moment after we ask.
			void revealAiProviderChat(this.commandService, this.configurationService, { retryMs: 6000 });
		});
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
