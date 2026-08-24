/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/ariaWslPrompt.css';
import { mainWindow } from '../../../../base/browser/window.js';
import { CommandsRegistry, ICommandService } from '../../../../platform/commands/common/commands.js';

/**
 * First-run "Install WSL & Ubuntu" prompt (Windows only).
 *
 * aria-autopipe detects, on launch, that the WSL engine is not installed and the
 * user has not opted out; it then runs `aria.wslPrompt.show`, which paints the
 * approved full-screen splash. It shows in one of two modes:
 *  - 'install' : the engine is missing and has never been installed here. Buttons
 *    delegate back to aria-autopipe: "Install WSL & Ubuntu" -> aria.autopipe.vm.installEngine
 *    (self-elevated `wsl --install`, then a reboot notice); "Continue without…" ->
 *    aria.autopipe.vm.skipSetup.
 *  - 'reboot'  : the installer already ran on this device but the user reopened Qoka
 *    before restarting, so the engine is not active yet. Re-asking to install would be
 *    wrong; instead we show a "restart to finish" notice.
 * The splash is dark + warm-gold in every theme, matching the mockup.
 */
type WslPromptMode = 'install' | 'reboot';

function showWslPrompt(commandService: ICommandService, mode: WslPromptMode): void {
	const doc = mainWindow.document;
	if (doc.querySelector('.aria-wsl-overlay')) { return; } // already up

	const overlay = doc.createElement('div');
	overlay.className = 'aria-wsl-overlay';

	const behind = doc.createElement('div');
	behind.className = 'aria-wsl-behind';
	behind.setAttribute('aria-hidden', 'true');
	overlay.appendChild(behind);

	const card = doc.createElement('div');
	card.className = 'aria-wsl-card';
	card.setAttribute('role', 'dialog');
	overlay.appendChild(card);

	const logoWrap = doc.createElement('div');
	logoWrap.className = 'aria-wsl-logo-wrap';
	const logo = doc.createElement('div');
	logo.className = 'aria-wsl-logo';
	logoWrap.appendChild(logo);
	card.appendChild(logoWrap);

	const eyebrow = doc.createElement('p');
	eyebrow.className = 'aria-wsl-eyebrow';
	eyebrow.textContent = 'First-time setup';
	card.appendChild(eyebrow);

	const h1 = doc.createElement('h1');
	card.appendChild(h1);

	const body = doc.createElement('p');
	body.className = 'aria-wsl-body';
	card.appendChild(body);

	const hint = doc.createElement('p');
	hint.className = 'aria-wsl-hint';
	card.appendChild(hint);

	const actions = doc.createElement('div');
	actions.className = 'aria-wsl-actions';
	card.appendChild(actions);

	const dismiss = () => { overlay.remove(); };

	// "Continue without the run environment": remember the opt-out both where the loader
	// reads it (localStorage) and in the extension (globalState via skipSetup), so the
	// prompt never returns and the normal MCP/CLI setup proceeds.
	const skipSetup = () => {
		console.log('[aria-wsl] continue-without (skip) clicked');
		try { localStorage.setItem('aria.autopipe.wslSetupSkipped', '1'); } catch { /* storage unavailable */ }
		void commandService.executeCommand('aria.autopipe.vm.skipSetup');
		dismiss();
	};

	if (mode === 'reboot') {
		renderRebootNotice();
	} else {
		renderInstallPrompt();
	}

	doc.body.appendChild(overlay);

	// ---- install prompt (engine missing, never installed here) ----------------------
	function renderInstallPrompt(): void {
		card.setAttribute('aria-label', 'Set up the run environment');
		h1.textContent = 'Set up the run environment';

		const strong = doc.createElement('b');
		strong.textContent = 'WSL';
		body.replaceChildren(
			doc.createTextNode('Qoka runs your code and pipelines inside a private Linux environment powered by '),
			strong,
			doc.createTextNode('.'),
			doc.createElement('br'),
			doc.createTextNode('Install it now to enable the built-in local environment.'),
		);
		hint.textContent = 'Only using your own SSH server? You can skip this installation.';

		const install = doc.createElement('button');
		install.className = 'aria-wsl-btn aria-wsl-btn-primary';
		install.type = 'button';
		install.textContent = 'Install WSL & Ubuntu';
		const skip = doc.createElement('button');
		skip.className = 'aria-wsl-btn aria-wsl-btn-ghost';
		skip.type = 'button';
		skip.textContent = 'Continue without the run environment';
		actions.replaceChildren(install, skip);

		install.addEventListener('click', () => {
			console.log('[aria-wsl] install button clicked');
			// Morph the whole card into an in-progress loading state. The install must NOT
			// let the app fall through to a usable workbench, so the prompt stays up (opaque,
			// on top) and keeps showing progress until the reboot notice.
			h1.textContent = 'Installing WSL & Ubuntu';
			body.replaceChildren(doc.createTextNode('This can take a few minutes. Please keep Qoka open.'));
			hint.textContent = '';
			const spinner = doc.createElement('div');
			spinner.className = 'aria-wsl-spinner';
			spinner.setAttribute('role', 'progressbar');
			spinner.setAttribute('aria-label', 'Installing WSL and Ubuntu');
			actions.replaceChildren(spinner);
			void Promise.resolve(commandService.executeCommand('aria.autopipe.vm.installEngine')).then(
				() => {
					// Installed (the elevated window closed). Swap the card to a reboot notice.
					console.log('[aria-wsl] installEngine resolved -> reboot notice');
					renderRebootNotice();
				},
				(err) => {
					// UAC declined or the install could not start. Show WHY (instead of a
					// silent revert that looks like the button did nothing), plus a retry.
					console.error('[aria-wsl] installEngine rejected:', err);
					h1.textContent = 'Could not start the installer';
					body.replaceChildren(doc.createTextNode(
						(err && (err.message || String(err))) || 'The WSL installer could not be started. Please try again.'));
					hint.textContent = '';
					const retry = doc.createElement('button');
					retry.className = 'aria-wsl-btn aria-wsl-btn-primary';
					retry.type = 'button';
					retry.textContent = 'Try again';
					retry.addEventListener('click', renderInstallPrompt);
					const skip2 = doc.createElement('button');
					skip2.className = 'aria-wsl-btn aria-wsl-btn-ghost';
					skip2.type = 'button';
					skip2.textContent = 'Continue without the run environment';
					skip2.addEventListener('click', skipSetup);
					actions.replaceChildren(retry, skip2);
					retry.focus();
				},
			);
		});

		skip.addEventListener('click', skipSetup);
		install.focus();
	}

	// ---- reboot notice (installer ran; engine active only after a restart) -----------
	function renderRebootNotice(): void {
		card.setAttribute('aria-label', 'Restart to finish setup');
		h1.textContent = 'Almost there';
		body.replaceChildren(
			doc.createTextNode('WSL and Ubuntu have been installed.'),
			doc.createElement('br'),
			doc.createTextNode('Restart your PC, then reopen Qoka to finish setup and create your Ubuntu account.'),
		);
		hint.textContent = '';

		const ok = doc.createElement('button');
		ok.className = 'aria-wsl-btn aria-wsl-btn-primary';
		ok.type = 'button';
		ok.textContent = 'OK';
		ok.addEventListener('click', dismiss);
		const skip = doc.createElement('button');
		skip.className = 'aria-wsl-btn aria-wsl-btn-ghost';
		skip.type = 'button';
		skip.textContent = 'Continue without the run environment';
		skip.addEventListener('click', skipSetup);
		actions.replaceChildren(ok, skip);
		ok.focus();
	}
}

// Registered at module level so aria-autopipe can call it during activate (before any
// workbench contribution would be constructed). The argument selects the mode; default
// to the install prompt for backward compatibility.
CommandsRegistry.registerCommand('aria.wslPrompt.show', (accessor, mode?: WslPromptMode) => {
	showWslPrompt(accessor.get(ICommandService), mode === 'reboot' ? 'reboot' : 'install');
});
