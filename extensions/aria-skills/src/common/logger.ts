/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

/**
 * A small shared logger for the extension. Routes diagnostic output to a
 * dedicated VS Code Output channel ("Aria Skills") so the user can see
 * exactly what we're sending to Claude and what comes back, without
 * digging through the Extension Host log.
 *
 * Open it from the menu: View → Output → "Aria Skills" in the dropdown.
 */

let channel: vscode.OutputChannel | undefined;

export function initLogger(name = 'Aria Skills'): vscode.OutputChannel {
	if (!channel) {
		channel = vscode.window.createOutputChannel(name);
	}
	return channel;
}

export function log(message: string): void {
	const stamped = `[${new Date().toISOString()}] ${message}`;
	if (channel) {
		channel.appendLine(stamped);
	}
	// Mirror to Extension Host console so the same line shows up in two
	// places — handy when the Output channel isn't open yet.
	console.log(`[aria-skills] ${stamped}`);
}

export function logBlock(label: string, body: string): void {
	const sep = '─'.repeat(Math.min(60, label.length + 4));
	const message = `${label}\n${sep}\n${body}\n${sep}`;
	if (channel) {
		channel.appendLine(`[${new Date().toISOString()}]`);
		channel.appendLine(message);
	}
	console.log(`[aria-skills] ${message}`);
}

export function showLogger(): void {
	channel?.show(true);
}
