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
 * approved full-screen splash. The two buttons delegate back to aria-autopipe
 * commands: "Install WSL & Ubuntu" -> aria.autopipe.vm.installEngine (self-elevated
 * `wsl --install`, then a reboot notice); "Continue without…" -> aria.autopipe.vm.skipSetup
 * (remembered so the prompt never returns) and the loader proceeds with the normal
 * MCP/CLI setup. The splash is dark + warm-gold in every theme, matching the mockup.
 */
function showWslPrompt(commandService: ICommandService): void {
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
	card.setAttribute('aria-label', 'Set up the run environment');
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
	h1.textContent = 'Set up the run environment';
	card.appendChild(h1);

	const body = doc.createElement('p');
	body.className = 'aria-wsl-body';
	body.appendChild(doc.createTextNode('Qoka runs your code and pipelines inside a private Linux environment powered by '));
	const strong = doc.createElement('b');
	strong.textContent = 'WSL';
	body.appendChild(strong);
	body.appendChild(doc.createTextNode('.'));
	body.appendChild(doc.createElement('br'));
	body.appendChild(doc.createTextNode('Install it now to enable the built-in local environment.'));
	card.appendChild(body);

	const hint = doc.createElement('p');
	hint.className = 'aria-wsl-hint';
	hint.textContent = 'Only using your own SSH server? You can skip this installation.';
	card.appendChild(hint);

	const actions = doc.createElement('div');
	actions.className = 'aria-wsl-actions';
	const install = doc.createElement('button');
	install.className = 'aria-wsl-btn aria-wsl-btn-primary';
	install.type = 'button';
	install.textContent = 'Install WSL & Ubuntu';
	const skip = doc.createElement('button');
	skip.className = 'aria-wsl-btn aria-wsl-btn-ghost';
	skip.type = 'button';
	skip.textContent = 'Continue without the run environment';
	actions.appendChild(install);
	actions.appendChild(skip);
	card.appendChild(actions);

	const dismiss = () => { overlay.remove(); };

	install.addEventListener('click', () => {
		install.disabled = true;
		skip.disabled = true;
		install.textContent = 'Starting the installer…';
		void Promise.resolve(commandService.executeCommand('aria.autopipe.vm.installEngine')).then(
			() => {
				// Installed (the elevated window closed). Swap the card to a reboot notice.
				body.replaceChildren(
					doc.createTextNode('WSL and Ubuntu are being installed.'),
					doc.createElement('br'),
					doc.createTextNode('Restart your PC, then reopen Qoka to finish setup and create your Ubuntu account.'),
				);
				hint.textContent = '';
				actions.replaceChildren();
				const ok = doc.createElement('button');
				ok.className = 'aria-wsl-btn aria-wsl-btn-primary';
				ok.type = 'button';
				ok.textContent = 'OK';
				ok.addEventListener('click', dismiss);
				actions.appendChild(ok);
			},
			() => {
				// UAC declined or the install could not start - let the user try again.
				install.disabled = false;
				skip.disabled = false;
				install.textContent = 'Install WSL & Ubuntu';
			},
		);
	});

	skip.addEventListener('click', () => {
		// Remember the opt-out both where the loader reads it (localStorage) and in the
		// extension (globalState via skipSetup), so the prompt never returns and the
		// normal MCP/CLI setup proceeds.
		try { localStorage.setItem('aria.autopipe.wslSetupSkipped', '1'); } catch { /* storage unavailable */ }
		void commandService.executeCommand('aria.autopipe.vm.skipSetup');
		dismiss();
	});

	doc.body.appendChild(overlay);
	install.focus();
}

// Registered at module level so aria-autopipe can call it during activate (before any
// workbench contribution would be constructed).
CommandsRegistry.registerCommand('aria.wslPrompt.show', (accessor) => {
	showWslPrompt(accessor.get(ICommandService));
});
