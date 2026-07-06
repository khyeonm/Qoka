/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as os from 'os';
import * as http from 'http';
import * as https from 'https';
import { URL } from 'url';

/**
 * Client for the cross-project ("user") memory — the mem0 service running on the
 * shared server. This is the counterpart to the local per-project wiki: where
 * the wiki stores project-scoped markdown on disk, this stores user-scoped facts
 * (preferences, working style, identity) in the server's pgvector via mem0, so
 * they follow the user across every project.
 *
 * The extension never talks to pgvector or the embedding model directly — it
 * only calls the mem0 HTTP API (FastAPI). See extensions/aria-memory/server/.
 *
 * Config (env, with test-friendly defaults):
 *   ARIA_MEMORY_SERVER_URL  base URL of the mem0 service (default: lab server)
 *   ARIA_MEMORY_USER_ID     which user's memory to read/write. A placeholder
 *                           until login exists — defaults to the OS username, to
 *                           be replaced by the app's internal UUID after
 *                           ORCID/Google sign-in.
 */

const SERVER_URL = process.env.ARIA_MEMORY_SERVER_URL || 'http://localhost:8000';
const USER_ID = process.env.ARIA_MEMORY_USER_ID || os.userInfo().username || 'default-user';

export function userMemoryConfig(): { serverUrl: string; userId: string } {
	return { serverUrl: SERVER_URL, userId: USER_ID };
}

function postJson(path: string, body: unknown, timeoutMs = 20000): Promise<unknown> {
	return new Promise((resolve, reject) => {
		const url = new URL(path, SERVER_URL);
		const payload = JSON.stringify(body);
		const lib = url.protocol === 'https:' ? https : http;
		const req = lib.request(
			url,
			{
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					'content-length': Buffer.byteLength(payload),
				},
				timeout: timeoutMs,
			},
			res => {
				let data = '';
				res.on('data', c => { data += c; });
				res.on('end', () => {
					const code = res.statusCode ?? 0;
					if (code < 200 || code >= 300) {
						reject(new Error(`mem0 server ${code}: ${data.slice(0, 300)}`));
						return;
					}
					try { resolve(JSON.parse(data || '{}')); } catch { resolve({ raw: data }); }
				});
			},
		);
		req.on('error', reject);
		req.on('timeout', () => { req.destroy(new Error('mem0 server timeout')); });
		req.write(payload);
		req.end();
	});
}

/**
 * Store a cross-project user fact. We pass `infer: false` so the fact is stored
 * as-is: the extraction/judgment was already done by the user's own provider
 * (the agent that decided this is a durable cross-project fact and called this
 * tool) — mem0's server-side LLM does NOT re-extract. This keeps a single
 * extraction pass, done by the user's provider, consistent with the project
 * wiki. Trade-off: mem0's own dedup/reconcile is skipped, so the agent should
 * `recall_user_memory` first and avoid re-storing a known fact (steered by the
 * rubric).
 */
export async function rememberUser(content: string, metadata?: Record<string, unknown>): Promise<unknown> {
	return postJson('/add', { messages: content, user_id: USER_ID, metadata, infer: false });
}

/** Semantic recall of the user's cross-project memory. */
export async function recallUser(query: string, limit = 5): Promise<Array<{ memory?: string; score?: number }>> {
	const res = (await postJson('/search', { query, user_id: USER_ID, limit })) as { results?: Array<{ memory?: string; score?: number }> };
	return res.results ?? [];
}
