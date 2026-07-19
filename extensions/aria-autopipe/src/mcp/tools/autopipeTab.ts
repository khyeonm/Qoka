/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

// Reveal the Autopipe sidebar tab at most once per MCP-server session, so when
// the assistant starts building / writing / running a pipeline the user sees it
// happen on the Autopipe tab (which otherwise stays closed while the work runs
// in the background over SSH). Guarded to fire once so a multi-step build (many
// write_file calls) does not steal focus on every step.
let revealed = false;

/**
 * Best-effort: open the Autopipe view container. Idempotent (revealing an
 * already-open container is a no-op) and never throws - in a headless /
 * registration-only context there is no workbench, and executeCommand's
 * rejection is swallowed. Call from the pipeline build/write/run tools.
 */
export function ensureAutopipeTabOpen(): void {
	if (revealed) {
		return;
	}
	revealed = true;
	try {
		// The open command id equals the view-container id (registered with
		// doNotRegisterOpenCommand: false). No `.focus` suffix.
		void Promise.resolve(vscode.commands.executeCommand('workbench.view.ariaAutopipe'))
			.then(undefined, () => { /* reveal is optional - the tool already ran */ });
	} catch {
		/* no UI available - best-effort */
	}
}
