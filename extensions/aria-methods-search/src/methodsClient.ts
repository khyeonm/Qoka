/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as http from 'http';
import * as https from 'https';
import { URL } from 'url';

/**
 * Client for the logic-graph methods recommendation on the Qoka server. The
 * graph (Neo4j) and the embeddings model live on the lab server (gemma4) which
 * the desktop app can't reach directly, so all queries go through the Django
 * API (`/api/methods/...`), exactly like the cross-project memory client.
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
const AUTH_ID = 'aria';
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
	semantic: MethodRow[] | Unavailable;
}

export interface HypothesisMatch {
	hypothesis: string;
	example_pmcid: string | null;
	score: number;
}

/** The current user's JWT access token, or throw if not signed in. */
async function authToken(): Promise<string> {
	const session = await vscode.authentication.getSession(AUTH_ID, [], { createIfNone: false });
	if (!session) {
		throw new Error('Not signed in to Qoka - methods search requires sign-in.');
	}
	return session.accessToken;
}

function postJson(path: string, body: unknown, token: string, timeoutMs = 30000): Promise<unknown> {
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
 * Recommend methods for a hypothesis. Returns both keyword and semantic modes
 * side by side; either side may be an `{ unavailable }` marker while the graph
 * or embeddings are still being loaded.
 */
export async function recommendMethods(hypothesis: string, topK = 10): Promise<Recommendation> {
	const token = await authToken();
	const res = await postJson('/api/methods/recommend', { hypothesis, top_k: topK }, token) as Recommendation;
	return {
		keyword: res?.keyword ?? [],
		semantic: res?.semantic ?? [],
	};
}

/** Inspect which stored hypotheses match a query (transparency / debugging). */
export async function searchHypotheses(query: string, limit = 10): Promise<HypothesisMatch[]> {
	const token = await authToken();
	const res = await postJson('/api/methods/hypotheses', { query, limit }, token) as HypothesisMatch[];
	return Array.isArray(res) ? res : [];
}
