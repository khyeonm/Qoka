/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as http from 'http';
import * as https from 'https';
import { URL } from 'url';

/**
 * Bibliographic records fetched from the registration agency that owns the
 * identifier.
 *
 * The assistant does not read metadata off a page - it transcribes it, and a
 * transcription loses things (a five-author paper becomes two authors) or invents
 * them (an online-first year instead of the issue year). Neither is detectable by
 * looking at the saved entry, so nothing here compares the assistant's fields
 * against the record: the record IS the answer, and the fields are replaced.
 *
 * Exactly one thing is checked, by `titlesMatch`: whether the identifier points
 * at the paper the assistant meant. Get that wrong and normalisation makes things
 * WORSE, because a completely different paper arrives with flawless metadata and
 * nothing on screen looks amiss.
 */

/** Contact string for Crossref's polite pool. No personal data - the product. */
const USER_AGENT = 'Qoka/1.0 (+https://qoka.org)';
const TIMEOUT_MS = 5000;
const MAX_REDIRECTS = 5;

/**
 * Offline circuit breaker.
 *
 * Every save with an identifier waits on a lookup, so a machine with no network
 * would otherwise pay the full timeout on every paper - a 20-paper batch turning
 * into a minute of nothing. After two transport failures in a row, stop trying
 * for a while and let the saves fall straight through as unverified; the
 * background sweep repairs them once the network is back.
 */
const BREAKER_THRESHOLD = 2;
const BREAKER_COOLDOWN_MS = 60_000;
let consecutiveTransportFailures = 0;
let breakerOpenedAt = 0;

function breakerIsOpen(): boolean {
	if (consecutiveTransportFailures < BREAKER_THRESHOLD) { return false; }
	if (Date.now() - breakerOpenedAt < BREAKER_COOLDOWN_MS) { return true; }
	consecutiveTransportFailures = 0;                          // cooled down, try again
	return false;
}

function noteTransportFailure(): void {
	consecutiveTransportFailures++;
	if (consecutiveTransportFailures === BREAKER_THRESHOLD) { breakerOpenedAt = Date.now(); }
}

function noteReachable(): void {
	consecutiveTransportFailures = 0;
}

export type MetadataSource = 'crossref' | 'datacite' | 'pubmed' | 'arxiv' | 'assistant';

/** A record as stored: the raw CSL-JSON plus the flat fields the library uses. */
export interface ResolvedRecord {
	csl: Record<string, unknown>;
	source: MetadataSource;
	title: string;
	authors: string[];
	year?: number;
	venue?: string;
	doi?: string;
	cslType?: string;
}

export interface ResolveInput {
	doi?: string;
	pmid?: string;
	arxiv?: string;
}

// --- HTTP -------------------------------------------------------------------

/**
 * The two ways a lookup can come back empty, which callers must tell apart:
 * `http` means the agency answered and does not have this (so try another
 * agency), `network` means nothing answered at all (so trying another agency
 * would just wait out a second timeout).
 */
type FetchResult =
	| { ok: true; json: unknown }
	| { ok: false; reason: 'http' | 'network' };

/**
 * GET a URL and parse JSON, following redirects by hand: doi.org answers with a
 * 302 to whichever agency owns the DOI, and node's http/https do not follow it.
 * Anything that is not a 200 with parseable JSON is "could not resolve", never
 * "the paper is wrong".
 */
async function getJson(target: string, accept: string, redirectsLeft = MAX_REDIRECTS): Promise<FetchResult> {
	let url: URL;
	try { url = new URL(target); } catch { return { ok: false, reason: 'http' }; }
	const lib = url.protocol === 'https:' ? https : http;

	const response = await new Promise<{ status: number; location?: string; body: string } | undefined>(resolve => {
		const request = lib.request(
			{
				protocol: url.protocol,
				hostname: url.hostname,
				port: url.port || undefined,
				path: `${url.pathname}${url.search}`,
				method: 'GET',
				headers: { 'Accept': accept, 'User-Agent': USER_AGENT },
				timeout: TIMEOUT_MS,
			},
			res => {
				const status = res.statusCode ?? 0;
				const location = res.headers.location;
				if (status >= 300 && status < 400 && location) {
					res.resume();                                  // drain, we only need the header
					resolve({ status, location, body: '' });
					return;
				}
				let body = '';
				res.setEncoding('utf8');
				res.on('data', chunk => { body += chunk; });
				res.on('end', () => resolve({ status, body }));
			},
		);
		request.on('timeout', () => { request.destroy(); resolve(undefined); });
		request.on('error', () => resolve(undefined));
		request.end();
	});

	if (!response) {
		noteTransportFailure();
		return { ok: false, reason: 'network' };
	}
	noteReachable();
	if (response.location) {
		if (redirectsLeft <= 0) { return { ok: false, reason: 'http' }; }
		return getJson(new URL(response.location, url).toString(), accept, redirectsLeft - 1);
	}
	if (response.status !== 200) { return { ok: false, reason: 'http' }; }
	try { return { ok: true, json: JSON.parse(response.body) }; } catch { return { ok: false, reason: 'http' }; }
}

// --- identifier normalisation ------------------------------------------------

/** Strip the prefixes a DOI is usually copied with, leaving the bare `10.x/y`. */
export function normalizeDoi(raw: string): string | undefined {
	const trimmed = raw.trim().replace(/^doi:\s*/i, '').replace(/^https?:\/\/(dx\.)?doi\.org\//i, '');
	return /^10\.\d{4,9}\//.test(trimmed) ? trimmed : undefined;
}

/** `2401.12345v2` -> `2401.12345`; the DOI is registered against the base id. */
function normalizeArxiv(raw: string): string | undefined {
	const trimmed = raw.trim().replace(/^arxiv:\s*/i, '').replace(/v\d+$/i, '');
	return trimmed ? trimmed : undefined;
}

// --- CSL-JSON ----------------------------------------------------------------

/** Registries sometimes deposit titles with markup or HTML entities in them. */
function cleanText(value: string): string {
	return value
		.replace(/<[^>]+>/g, '')
		.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'")
		.replace(/\s+/g, ' ')
		.trim();
}

/** CSL fields come as a string in some deposits and a one-element array in others. */
function firstString(value: unknown): string | undefined {
	if (typeof value === 'string') { return cleanText(value); }
	if (Array.isArray(value) && typeof value[0] === 'string') { return cleanText(value[0]); }
	return undefined;
}

function authorNames(value: unknown): string[] {
	if (!Array.isArray(value)) { return []; }
	const names: string[] = [];
	for (const raw of value) {
		if (!raw || typeof raw !== 'object') { continue; }
		const author = raw as { given?: unknown; family?: unknown; literal?: unknown };
		if (typeof author.literal === 'string' && author.literal.trim()) {
			names.push(cleanText(author.literal));                 // an organisation
			continue;
		}
		const given = typeof author.given === 'string' ? cleanText(author.given) : '';
		const family = typeof author.family === 'string' ? cleanText(author.family) : '';
		const full = [given, family].filter(Boolean).join(' ');
		if (full) { names.push(full); }
	}
	return names;
}

function issuedYear(value: unknown): number | undefined {
	const parts = (value as { 'date-parts'?: unknown })?.['date-parts'];
	if (!Array.isArray(parts) || !Array.isArray(parts[0])) { return undefined; }
	const year = Number(parts[0][0]);
	return Number.isFinite(year) && year > 0 ? year : undefined;
}

function toRecord(csl: Record<string, unknown>, source: MetadataSource): ResolvedRecord | undefined {
	const title = firstString(csl.title);
	if (!title) { return undefined; }                          // unusable without one
	return {
		csl,
		source,
		title,
		authors: authorNames(csl.author),
		year: issuedYear(csl.issued),
		venue: firstString(csl['container-title']) ?? firstString(csl.publisher),
		doi: typeof csl.DOI === 'string' ? csl.DOI : undefined,
		cslType: typeof csl.type === 'string' ? csl.type : undefined,
	};
}

// --- resolution --------------------------------------------------------------

const CSL_ACCEPT = 'application/vnd.citationstyles.csl+json';

async function resolveByDoi(doi: string): Promise<ResolvedRecord | undefined> {
	const clean = normalizeDoi(doi);
	if (!clean) { return undefined; }
	// The DOI's own slash is a path separator here, so it must NOT be encoded.
	const crossref = await getJson(
		`https://api.crossref.org/works/${clean}/transform/${CSL_ACCEPT}`,
		CSL_ACCEPT,
	);
	if (crossref.ok && crossref.json && typeof crossref.json === 'object') {
		const record = toRecord(crossref.json as Record<string, unknown>, 'crossref');
		if (record) { return record; }
	}
	// Nothing answered - the second agency will not answer either.
	if (!crossref.ok && crossref.reason === 'network') { return undefined; }
	// Answered, but not a Crossref DOI (DataCite, mEDRA, …). Content negotiation
	// on doi.org reaches every agency, at the cost of a redirect hop.
	const negotiated = await getJson(`https://doi.org/${clean}`, CSL_ACCEPT);
	if (negotiated.ok && negotiated.json && typeof negotiated.json === 'object') {
		return toRecord(negotiated.json as Record<string, unknown>, 'datacite');
	}
	return undefined;
}

/** PubMed's own summary, used only when the record carries no DOI to defer to. */
async function resolveByPmid(pmid: string): Promise<ResolvedRecord | undefined> {
	const id = pmid.trim().replace(/^pmid:\s*/i, '');
	if (!/^\d+$/.test(id)) { return undefined; }
	const payload = await getJson(
		`https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=pubmed&id=${id}&retmode=json`,
		'application/json',
	);
	if (!payload.ok) { return undefined; }
	const summary = (payload.json as { result?: Record<string, unknown> })?.result?.[id] as Record<string, unknown> | undefined;
	if (!summary) { return undefined; }

	const articleIds = Array.isArray(summary.articleids) ? summary.articleids : [];
	const doi = articleIds
		.map(entry => entry as { idtype?: unknown; value?: unknown })
		.find(entry => entry.idtype === 'doi' && typeof entry.value === 'string')?.value as string | undefined;
	if (doi) {
		const viaDoi = await resolveByDoi(doi);
		if (viaDoi) { return viaDoi; }
	}

	const title = typeof summary.title === 'string' ? cleanText(summary.title) : undefined;
	if (!title) { return undefined; }
	const authors = Array.isArray(summary.authors)
		? summary.authors.map(a => (a as { name?: unknown }).name).filter((n): n is string => typeof n === 'string')
		: [];
	const pubdate = typeof summary.pubdate === 'string' ? summary.pubdate : '';
	const year = Number(pubdate.slice(0, 4));
	const venue = typeof summary.fulljournalname === 'string' ? summary.fulljournalname : undefined;
	// Hand-built CSL so the entry still exports and cites like any other.
	const csl: Record<string, unknown> = {
		type: 'article-journal',
		title,
		'container-title': venue,
		author: authors.map(name => ({ literal: name })),
		issued: Number.isFinite(year) ? { 'date-parts': [[year]] } : undefined,
		volume: summary.volume, issue: summary.issue, page: summary.pages,
		PMID: id,
	};
	return { csl, source: 'pubmed', title, authors, year: Number.isFinite(year) ? year : undefined, venue, cslType: 'article-journal' };
}

/** arXiv registers DOIs of its own, so this is just a DOI lookup in disguise. */
async function resolveByArxiv(arxiv: string): Promise<ResolvedRecord | undefined> {
	const id = normalizeArxiv(arxiv);
	if (!id) { return undefined; }
	const record = await resolveByDoi(`10.48550/arXiv.${id}`);
	return record ? { ...record, source: 'arxiv' } : undefined;
}

/**
 * Fetch the canonical record for whichever identifier is available. DOI first: it
 * covers journals, bioRxiv/medRxiv (10.1101) and arXiv (10.48550) alike.
 */
export async function resolveIdentifier(input: ResolveInput): Promise<ResolvedRecord | undefined> {
	// Nothing has answered for a while: fall through immediately so saving stays
	// fast offline. The entry is marked unverified and repaired later.
	if (breakerIsOpen()) { return undefined; }
	if (input.doi) {
		const record = await resolveByDoi(input.doi);
		if (record) { return record; }
	}
	if (input.pmid) {
		const record = await resolveByPmid(input.pmid);
		if (record) { return record; }
	}
	if (input.arxiv) {
		const record = await resolveByArxiv(input.arxiv);
		if (record) { return record; }
	}
	return undefined;
}

// --- identity check ----------------------------------------------------------

const STOPWORDS = new Set([
	'a', 'an', 'the', 'of', 'for', 'and', 'or', 'in', 'on', 'to', 'with', 'by',
	'from', 'at', 'as', 'is', 'are', 'via', 'using',
]);

function titleTokens(title: string): Set<string> {
	return new Set(
		title
			.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
			.toLowerCase().replace(/[^a-z0-9]+/g, ' ')
			.split(' ')
			.filter(token => token && !STOPWORDS.has(token)),
	);
}

/**
 * Whether two titles name the same paper.
 *
 * Only the title is compared. Authors, year and venue disagree for perfectly
 * ordinary reasons - a truncated author list, online-first versus issue year, a
 * preprint versus the published version - so a mismatch there is not evidence of
 * anything, and treating it as such would ask the user a pointless question on
 * almost every save.
 *
 * Two ways to pass. Containment covers the very common case of a dropped
 * subtitle ("Towards a unified atlas" for "Towards a unified atlas for production
 * ranking"), but only when the shorter title carries enough words to be
 * distinctive. Otherwise a Dice coefficient over the content words.
 */
export function titlesMatch(claimed: string, resolved: string): boolean {
	const a = titleTokens(claimed);
	const b = titleTokens(resolved);
	if (a.size === 0 || b.size === 0) { return false; }

	const [shorter, longer] = a.size <= b.size ? [a, b] : [b, a];
	const overlap = [...shorter].filter(token => longer.has(token)).length;

	if (shorter.size >= 3 && overlap === shorter.size) { return true; }
	return (2 * overlap) / (a.size + b.size) >= 0.75;
}
