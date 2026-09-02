/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';

/**
 * Which loop's detail is currently open in the editor, so the Loops SIDEBAR list can grey out that
 * row. The qoka-loop EXTENSION owns the detail webview; it reports the open loop id (or undefined when
 * the panel closes) by executing the `qoka.loop.markOpen` command registered here.
 */
export const openLoopState: { id: string | undefined } = { id: undefined };

const _onDidChangeOpenLoop = new Emitter<void>();
export const onDidChangeOpenLoop: Event<void> = _onDidChangeOpenLoop.event;

CommandsRegistry.registerCommand('qoka.loop.markOpen', (_accessor, id?: unknown) => {
	const next = typeof id === 'string' ? id : undefined;
	if (next === openLoopState.id) { return; }
	openLoopState.id = next;
	_onDidChangeOpenLoop.fire();
});
