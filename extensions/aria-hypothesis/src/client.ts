/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as http from 'http';
import * as https from 'https';
import { URL } from 'url';

/**
 * Client for the hypothesis-search endpoint on the Qoka server, behind login.
 *
 * The server holds the ~1M-paper research corpus (flat shards) and greps it via
 * `search_corpus.py`. This extension never touches the corpus directly - it sends
 * the app's JWT (from the `aria` auth session) as a Bearer token to the Django
 * API, which runs the grep and returns candidate papers + context windows.
 *
 * Config (env):
 *   ARIA_HYPOTHESIS_SERVER_URL   base URL of the Qoka server (default: qoka.org)
 *   ARIA_HYPOTHESIS_INSECURE_TLS set to '1' to ACCEPT self-signed certs. The
 *                                lab server may use a self-signed cert (Caddy
 *                                `tls internal`), but the real server has a CA cert so verification is strict by default.
 */

const SERVER_URL = process.env.ARIA_HYPOTHESIS_SERVER_URL || 'https://qoka.org';
const AUTH_ID = 'aria';
const ALLOW_SELF_SIGNED = process.env.ARIA_HYPOTHESIS_INSECURE_TLS === '1';

// The server greps the whole corpus (~4-5s) per query; allow generous headroom
// above the server's own 60s subprocess cap so a slow-but-valid search is not cut.
const SEARCH_TIMEOUT_MS = 70000;

/** The current user's JWT access token, or throw if not signed in. */
async function authToken(): Promise<string> {
	const session = await vscode.authentication.getSession(AUTH_ID, [], { createIfNone: false });
	if (!session) {
		throw new Error('Not signed in to Qoka - hypothesis search requires sign-in.');
	}
	return session.accessToken;
}

function postJson(path: string, body: unknown, token: string, timeoutMs: number): Promise<unknown> {
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
				'authorization': `Bearer ${token}`,
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
					reject(new Error(`Qoka hypothesis ${code}: ${data.slice(0, 300)}`));
					return;
				}
				try { resolve(JSON.parse(data || '{}')); } catch { resolve({ raw: data }); }
			});
		});
		req.on('error', reject);
		req.on('timeout', () => { req.destroy(new Error('Qoka hypothesis server timeout')); });
		req.write(payload);
		req.end();
	});
}

/**
 * Grep the corpus for a hypothesis. `primary` is the anchoring keyword (AND term)
 * and `kw` are the defining secondaries; the server auto-falls back AND -> OR ->
 * primary-only. Returns `{ match_mode, n, results: [{ pmcid, title, year, journal,
 * context[] }] }`.
 */
export async function searchHypothesis(primary: string, kw: string[], topn: number): Promise<unknown> {
	const token = await authToken();
	return postJson('/api/hypothesis/search', { primary, kw, topn }, token, SEARCH_TIMEOUT_MS);
}

/** Pull one paper's full packed content line (abstract+body, refs removed) for a wider read. */
export async function getFulltext(pmcid: string): Promise<unknown> {
	const token = await authToken();
	return postJson('/api/hypothesis/fulltext', { pmcid }, token, SEARCH_TIMEOUT_MS);
}
