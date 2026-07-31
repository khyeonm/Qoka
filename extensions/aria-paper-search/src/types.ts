/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/** One paper as stored in the user's Qoka paper library. */
export interface PaperLibraryEntry {
	/** Stable identifier - DOI when available, otherwise a hash of URL/title. */
	id: string;
	/**
	 * Key used to cite this paper in a research note, as `[@citekey]` (pandoc
	 * syntax, the same one the manuscript writer uses). Generated as
	 * `familyYear` (e.g. `lu2026`) and kept unique across the library; entries
	 * saved before this field existed are backfilled on the next library read.
	 * Never regenerated for an existing paper, so citations already written into
	 * notes keep resolving when its metadata is refreshed.
	 */
	citekey: string;
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
	/**
	 * The registration agency's own CSL-JSON for this paper, cached from the DOI
	 * (or PMID / arXiv id). Present means the bibliographic fields above came from
	 * the publisher rather than from the assistant transcribing a search result.
	 * Doubles as the `--bibliography` input a future export needs, so nothing has
	 * to be rebuilt for it.
	 */
	csl?: Record<string, unknown>;
	/** Where the metadata came from. `assistant` = unverified transcription. */
	metadataSource?: 'crossref' | 'datacite' | 'pubmed' | 'arxiv' | 'assistant';
	/** ISO timestamp of the last successful lookup. */
	resolvedAt?: string;
	/** CSL item type (article-journal, preprint, …), needed to render a reference. */
	cslType?: string;
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
