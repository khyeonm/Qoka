/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as http from 'http';
import * as https from 'https';
import { URL } from 'url';
import { QOKA_API_KEY } from './qokaKey.js';

/**
 * Client for the logic-graph methods recommendation on the Qoka server. The
 * graph (Neo4j) lives on the lab server which the desktop app can't reach
 * directly, so all queries go through the Django API (`/api/methods/...`),
 * exactly like the cross-project memory client.
 *
 * Auth mirrors aria-memory: we never construct a user id - the app's JWT (from
 * the `aria` auth session) is sent as a Bearer token and the server authorizes
 * the request. Sign-in is therefore required.
 *
 * Config (env):
 *   ARIA_METHODS_SERVER_URL   base URL of the Qoka server (default: qoka.org)
 *   ARIA_METHODS_INSECURE_TLS set to '1' to ACCEPT self-signed certs. The
 *                             lab server may use a self-signed cert (Caddy
 *                             `tls internal`), but the real server has a CA cert so verification is strict by default.
 */

const SERVER_URL = process.env.ARIA_METHODS_SERVER_URL || 'https://qoka.org';
/**
 * The key actually sent. A release build has it baked into `qokaKey.ts` by CI;
 * a local dev build leaves that empty, so fall back to a `QOKA_API_KEY` env var
 * exported in the shell that launched the app. Without either, gated endpoints
 * answer 401 and the tools report that instead of data.
 */
const APP_KEY = QOKA_API_KEY || process.env.QOKA_API_KEY || '';
const ALLOW_SELF_SIGNED = process.env.ARIA_METHODS_INSECURE_TLS === '1';

/** A single recommended method row. */
export interface MethodRow {
	method: string;
	type: string;
	paper_support: number;
	hypothesis_support: number;
}

/** When a mode's index/data isn't loaded yet the server returns this marker. */
export interface Unavailable {
	unavailable: string;
}

export interface Recommendation {
	keyword: MethodRow[] | Unavailable;
	/** Query-expansion mode: the union of the hypotheses matched by EVERY phrasing the
	 *  assistant supplied. Present only when `expansions` were sent. Benchmarked as the
	 *  most phrasing-stable mode, so it is what the tool reports when available. */
	keyword_expanded?: MethodRow[] | Unavailable;
	/** Embedding (vector) mode. Being retired - see recommend_methods; kept so an older
	 *  server that still returns it does not break the client. */
	semantic?: MethodRow[] | Unavailable;
}

export interface HypothesisMatch {
	hypothesis: string;
	example_pmcid: string | null;
	score: number;
}

function postJson(path: string, body: unknown, timeoutMs = 30000): Promise<unknown> {
	return new Promise((resolve, reject) => {
		const url = new URL(path, SERVER_URL);
		const payload = JSON.stringify(body);
		const isHttps = url.protocol === 'https:';
		const lib = isHttps ? https : http;
		const options: https.RequestOptions = {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				'content-length': Buffer.byteLength(payload),
				'x-qoka-key': APP_KEY,
			},
			timeout: timeoutMs,
		};
		if (isHttps && ALLOW_SELF_SIGNED) {
			options.rejectUnauthorized = false;
		}
		const req = lib.request(url, options, res => {
			let data = '';
			res.on('data', c => { data += c; });
			res.on('end', () => {
				const code = res.statusCode ?? 0;
				if (code < 200 || code >= 300) {
					reject(new Error(`Qoka methods ${code}: ${data.slice(0, 300)}`));
					return;
				}
				try { resolve(JSON.parse(data || '{}')); } catch { resolve({ raw: data }); }
			});
		});
		req.on('error', reject);
		req.on('timeout', () => { req.destroy(new Error('Qoka methods server timeout')); });
		req.write(payload);
		req.end();
	});
}

/**
 * Recommend methods for a hypothesis. A list may be an `{ unavailable }` marker
 * while the graph is being (re)loaded, so callers must handle that shape.
 */
export async function recommendMethods(hypothesis: string, topK = 10, expansions: string[] = []): Promise<Recommendation> {
	// `expansions` are other phrasings of the SAME hypothesis, written by the assistant.
	// The server searches each one separately and unions the matched hypotheses, which
	// recovers the paraphrase robustness the embedding mode used to provide (measured:
	// phrasing stability 0.29 expanded vs 0.23 embedding over 30 hypotheses).
	const body: Record<string, unknown> = { hypothesis, top_k: topK };
	if (expansions.length) {
		body.expansions = expansions.slice(0, 5);
	}
	const res = await postJson('/api/methods/recommend', body) as Recommendation;
	const out: Recommendation = { keyword: res?.keyword ?? [] };
	if (res?.keyword_expanded !== undefined) {
		out.keyword_expanded = res.keyword_expanded;
	}
	if (res?.semantic !== undefined) {
		out.semantic = res.semantic;
	}
	return out;
}

/** Inspect which stored hypotheses match a query (transparency / debugging). */
export async function searchHypotheses(query: string, limit = 10): Promise<HypothesisMatch[]> {
	const res = await postJson('/api/methods/hypotheses', { query, limit }) as HypothesisMatch[];
	return Array.isArray(res) ? res : [];
}
