/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

/**
 * Read-only view of the project's paper library, which is the ONLY source of
 * valid citekeys. Fetched through the `aria.paperSearch.list` command rather than
 * by reading the file, so citekey generation (and the one-time backfill of older
 * entries) stays owned by the aria-paper-search extension and cannot drift.
 */

export interface CitablePaper {
	id: string;
	citekey: string;
	title: string;
	authors: string[];
	year?: number;
	venue?: string;
}

export async function citablePapers(): Promise<CitablePaper[]> {
	try {
		const state = await vscode.commands.executeCommand<{ papers?: CitablePaper[] }>('aria.paperSearch.list');
		const papers = state?.papers;
		return Array.isArray(papers) ? papers.filter(p => p && typeof p.citekey === 'string' && p.citekey) : [];
	} catch {
		// The paper-library extension has not activated (or no folder is open).
		// Callers treat an empty library as "cannot validate", never as "the key
		// is wrong", so a startup race can't reject a legitimate citation.
		return [];
	}
}

/** Map citekey -> paper, for validating and describing citations. */
export async function citableByKey(): Promise<Map<string, CitablePaper>> {
	return new Map((await citablePapers()).map(p => [p.citekey, p]));
}
