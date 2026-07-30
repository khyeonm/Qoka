/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, append } from '../../../../../base/browser/dom.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';

/**
 * One section of the Settings page. Sections render into a `body` element and talk to
 * the existing tab backends through `commandService` (the same `aria.*` commands the
 * old sidebar tabs used), so no backend / MCP change is needed. `header` is the
 * section's title row, so a section can pin an action (e.g. a "+") next to its title.
 */
export abstract class SettingsSection extends Disposable {
	constructor(
		protected readonly body: HTMLElement,
		protected readonly commandService: ICommandService,
		protected readonly header?: HTMLElement,
	) {
		super();
	}

	/** Add a codicon action button to the right of the section's title row. */
	protected addHeaderAction(codicon: string, title: string, onClick: () => void): void {
		if (!this.header) { return; }
		const btn = append(this.header, $(`span.codicon.${codicon}`)) as HTMLElement;
		btn.title = title;
		Object.assign(btn.style, { marginLeft: 'auto', cursor: 'pointer', opacity: '0.8', padding: '2px', fontSize: '15px' });
		btn.onclick = onClick;
	}

	/** Add a blue "How to use?"-style text link to the right end of the title row. It
	 *  overrides the header's uppercase/bold styling so it reads as a normal link. */
	protected addHeaderTextAction(text: string, title: string, onClick: () => void): void {
		if (!this.header) { return; }
		const link = append(this.header, $('a')) as HTMLElement;
		link.textContent = text;
		link.title = title;
		Object.assign(link.style, {
			marginLeft: 'auto', cursor: 'pointer', color: 'var(--vscode-button-background)',
			fontSize: '11px', fontWeight: '400', textTransform: 'none', letterSpacing: 'normal',
		});
		link.onclick = onClick;
	}

	/** Fetch state and (re)render this section's body. Never throws. */
	abstract refresh(): Promise<void>;
}
