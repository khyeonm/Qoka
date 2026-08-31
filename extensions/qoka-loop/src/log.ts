/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// A single user-visible diagnostics channel for the loop engine (View -> Output -> "Qoka Loop").
// The code version tree depends on git being found and the per-iteration commit succeeding, both of
// which happen deep in best-effort try/catch paths. When something silently does nothing (no versions,
// no commit), this channel is where the reason shows up: which git binary resolved, the code dir, and
// each git step's result or error.

import * as vscode from 'vscode';

let channel: vscode.OutputChannel | undefined;

export function loopLog(msg: string): void {
	try {
		if (!channel) { channel = vscode.window.createOutputChannel('Qoka Loop'); }
		channel.appendLine(new Date().toISOString() + '  ' + msg);
	} catch { /* logging must never throw */ }
}
