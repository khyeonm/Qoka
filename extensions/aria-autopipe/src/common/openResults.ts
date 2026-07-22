/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { humanSize } from './workspaceSync';

/**
 * Show a finished run's results instead of only reporting where they are.
 *
 * Shared by qoka-run's run_code and autopipe's pipeline completion so both
 * behave identically: a few representative files open as editor tabs, and
 * everything else is listed with its full path so the user can open what they
 * want. Without this, results were technically saved but invisible - the user
 * had to be told a folder name and go dig for them.
 */

/** Run scaffolding, not a result - never worth opening a tab for. */
const RUN_SCAFFOLDING = new Set(['main.sh', 'main.py', 'main.js', 'stdout.log', 'stderr.log', 'pipeline.log', '.autopipe-run.json']);

/** Extensions the editor can actually display usefully. Anything else (.h5ad,
 *  .bam, .npz, a bare binary) would open as garbage or a "cannot display"
 *  placeholder, so it is left for the user to handle from the Explorer. */
const OPENABLE_EXTENSIONS = new Set([
	'.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp', '.svg',
	'.txt', '.csv', '.tsv', '.md', '.json', '.yaml', '.yml', '.html', '.pdf',
]);

/** Don't open something big enough to hang the editor; point at it instead. */
const MAX_OPEN_BYTES = 5 * 1024 * 1024;

/** A few REPRESENTATIVE files, not everything: a run that writes 50 plots would
 *  otherwise bury every other tab the user had open. */
export const MAX_OPEN_TABS = 3;

/** Lower sorts first. A figure is the point of most analyses; a table can be read
 *  elsewhere; a text/log-ish file is usually supporting material. */
function displayPriority(rel: string): number {
	const ext = path.extname(rel).toLowerCase();
	if (['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp', '.svg'].includes(ext)) { return 0; }
	if (['.pdf', '.html'].includes(ext)) { return 1; }
	if (['.csv', '.tsv'].includes(ext)) { return 2; }
	return 3;
}

export interface OpenedResults {
	/** Files now showing as editor tabs. */
	opened: string[];
	/** Everything else worth mentioning, already rendered as "name - path (why)". */
	remaining: string[];
}

/**
 * Open up to MAX_OPEN_TABS of `files` as editor tabs under `localDir`.
 *
 * `files` are paths relative to `localDir`, POSIX-separated (that is how both
 * the remote listing and the run's own `ls` report them).
 *
 * `preserveFocus` keeps the caret in the chat: the user is mid-conversation, and
 * stealing focus to an image preview would interrupt them. Best-effort - a file
 * that refuses to open must never fail the run that produced it.
 */
export async function openResultsInEditor(localDir: string, files: string[]): Promise<OpenedResults> {
	const opened: string[] = [];
	const remaining: string[] = [];
	// Only a few files get a tab, so spend them on what the user most wants to
	// LOOK at. Sorted alphabetically, a run that writes three CSVs and a plot
	// showed three tables and hid the figure - the opposite of useful.
	for (const rel of [...files].sort((a, b) => displayPriority(a) - displayPriority(b))) {
		const name = rel.split('/').pop() ?? rel;
		if (RUN_SCAFFOLDING.has(name)) { continue; }
		const full = path.join(localDir, ...rel.split('/').filter(Boolean));
		let size: number;
		try {
			if (!fs.existsSync(full)) { continue; }
			const stat = fs.statSync(full);
			if (!stat.isFile()) { continue; }
			size = stat.size;
		} catch { continue; }

		const note = (why: string) => remaining.push(`${rel} - ${full} (${why})`);
		if (!OPENABLE_EXTENSIONS.has(path.extname(name).toLowerCase())) {
			note('the editor cannot display this format');
			continue;
		}
		if (size > MAX_OPEN_BYTES) {
			note(`${humanSize(size)}, too large to open in the editor`);
			continue;
		}
		if (opened.length >= MAX_OPEN_TABS) {
			note(`not opened - only ${MAX_OPEN_TABS} representative files are shown as tabs`);
			continue;
		}
		try {
			await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(full), { preview: false, preserveFocus: true });
			opened.push(rel);
		} catch {
			note('could not be opened');
		}
	}
	return { opened, remaining };
}

/** Render the shared "here is what is on screen / here is what is not" block. */
export function describeOpenedResults(shown: OpenedResults): string[] {
	const lines: string[] = [];
	if (shown.opened.length) {
		lines.push(`Already OPEN in the editor as tabs (${MAX_OPEN_TABS} representative files at most): ${shown.opened.join(', ')}.`
			+ ' Tell the user to look at the editor - do not tell them to open these themselves, and do not paste their contents into chat.');
	}
	if (shown.remaining.length) {
		lines.push('Not opened, still on disk - give the user these paths so they can open the ones they want:');
		for (const entry of shown.remaining) {
			lines.push(`  ${entry}`);
		}
	}
	return lines;
}
