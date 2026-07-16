/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/** One paper as stored in the user's Aria paper library. */
export interface PaperLibraryEntry {
	/** Stable identifier - DOI when available, otherwise a hash of URL/title. */
	id: string;
	title: string;
	authors: string[];
	year: number | undefined;
	venue: string | undefined;
	doi: string | undefined;
	url: string | undefined;
	pdfUrl: string | undefined;
	abstract: string | undefined;
	/** Where the paper was found - used for badge display, no special handling. */
	source: 'openalex' | 'crossref' | 'arxiv' | 'biorxiv' | 'pubmed' | 'other';
	/** ISO timestamp the paper was added. */
	savedAt: string;
	/** Free-text note the user can edit from the sidebar. */
	note: string;
	/** User-managed tags for filtering in the library. */
	tags: string[];
}

/** The on-disk schema for the per-project <workspace>/references/paper-library.json. */
export interface PaperLibrary {
	version: number;
	papers: PaperLibraryEntry[];
}

/** Snapshot the sidebar fetches via `aria.paperSearch.list`. */
export interface PaperLibraryState {
	papers: PaperLibraryEntry[];
	tags: string[];
}
