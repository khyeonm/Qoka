/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

/**
 * Which research notes cite a given paper.
 *
 * Deleting a paper from the library is the one moment a citation can silently
 * break: the `[@citekey]` markers stay in the notes but stop resolving, and the
 * note renders them as plain text. So the delete flow asks here first and warns
 * the user by name.
 *
 * Notes are plain JSON on disk (`.qoka/notebook/notes/*.json`, BlockNote blocks),
 * so this reads them directly rather than going through the aria-notes extension -
 * no activation-order coupling for what is a read-only check.
 */

function notesDir(): string | undefined {
	const folder = vscode.workspace.workspaceFolders?.[0];
	if (!folder || folder.uri.scheme !== 'file') { return undefined; }
	return path.join(folder.uri.fsPath, '.qoka', 'notebook', 'notes');
}

/** Every text run in a BlockNote document, concatenated. Deliberately loose: a
 *  citation marker is plain text wherever it sits, so we only need to see strings. */
function allText(value: unknown, out: string[]): void {
	if (typeof value === 'string') {
		out.push(value);
		return;
	}
	if (Array.isArray(value)) {
		for (const v of value) { allText(v, out); }
		return;
	}
	if (value && typeof value === 'object') {
		for (const v of Object.values(value as Record<string, unknown>)) { allText(v, out); }
	}
}

/** Titles of the notes that cite `citekey`, so the warning can name them. */
export function notesCiting(citekey: string): string[] {
	const dir = notesDir();
	if (!dir || !citekey) { return []; }
	let files: string[];
	try {
		files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
	} catch {
		return [];
	}
	// `[@key]` and `[@a; @key]` both count; the key is bounded so `[@lu2026]`
	// does not match a longer key such as `[@lu2026a]`.
	const marker = new RegExp(`\\[@[^\\]]*(?<![A-Za-z0-9_])${citekey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9_])[^\\]]*\\]`);
	const titles: string[] = [];
	for (const file of files) {
		try {
			const parsed = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
			const parts: string[] = [];
			allText(parsed.blocks, parts);
			if (marker.test(parts.join('\n'))) {
				titles.push(typeof parsed.title === 'string' && parsed.title ? parsed.title : file.replace(/\.json$/, ''));
			}
		} catch {
			// Unreadable note - skip it rather than blocking the delete.
		}
	}
	return titles;
}
