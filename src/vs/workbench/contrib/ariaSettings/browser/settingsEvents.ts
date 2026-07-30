/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';

/**
 * Fired when the aria-skills extension asks the Skills UI to refresh (it used to poke
 * the retired Skills view's `aria.skills.requestRefresh` command). The Settings
 * contribution registers that command to fire this; the open Settings editor listens
 * and refreshes its Skills section.
 */
const _onDidRequestSkillsRefresh = new Emitter<void>();
export const onDidRequestSkillsRefresh: Event<void> = _onDidRequestSkillsRefresh.event;

export function fireSkillsRefresh(): void {
	_onDidRequestSkillsRefresh.fire();
}
