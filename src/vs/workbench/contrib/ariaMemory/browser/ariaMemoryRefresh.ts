/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';

/**
 * A tiny standalone signal (own module so neither the pane nor the contribution
 * import each other) that asks an OPEN Memory tab to reload BOTH sections. The
 * aria-memory extension fires the `aria.memory.refresh` command after a chat
 * saved or deleted a memory via its MCP tools, so the tab reflects it at once.
 */
const _onDidRequestMemoryRefresh = new Emitter<void>();
export const onDidRequestAriaMemoryRefresh: Event<void> = _onDidRequestMemoryRefresh.event;

CommandsRegistry.registerCommand('aria.memory.refresh', () => _onDidRequestMemoryRefresh.fire());
