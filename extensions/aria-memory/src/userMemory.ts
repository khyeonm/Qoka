/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as http from 'http';
import * as https from 'https';
import { URL } from 'url';

/**
 * Client for the cross-project ("user") memory — mem0 on the Aria server, behind
 * login. This is the counterpart to the local per-project wiki: where the wiki
 * stores project-scoped markdown on disk, this stores user-scoped facts
 * (preferences, working style, identity) in the server's pgvector via mem0, so
 * they follow the user across every project.
 *
 * Scoping is by the signed-in user's UUID, and the client NEVER supplies it: we
 * send the app's JWT (from the `aria` auth session) as a Bearer token, and the
 * Django API derives the mem0 `user_id` from `request.auth.id`. So a user can
 * only ever read/write their own memory. Sign-in is therefore required.
 *
 * Config (env):
 *   ARIA_MEMORY_SERVER_URL   base URL of the Aria server (default: aria.pnucolab.com)
 *   ARIA_MEMORY_INSECURE_TLS set to '0' to enforce strict TLS verification. The
 *                            lab server may use a self-signed cert (Caddy
 *                            `tls internal`), so self-signed is allowed by default.
 */

const SERVER_URL = process.env.ARIA_MEMORY_SERVER_URL || 'https://aria.pnucolab.com';
const AUTH_ID = 'aria';
const ALLOW_SELF_SIGNED = process.env.ARIA_MEMORY_INSECURE_TLS !== '0';

/** The current user's JWT access token, or throw if not signed in. */
async function authToken(): Promise<string> {
	const session = await vscode.authentication.getSession(AUTH_ID, [], { createIfNone: false });
	if (!session) {
		throw new Error('Not signed in to Aria — cross-project memory requires sign-in.');
	}
	return session.accessToken;
}

function postJson(path: string, body: unknown, token: string, timeoutMs = 20000): Promise<unknown> {
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
					reject(new Error(`Aria memory ${code}: ${data.slice(0, 300)}`));
					return;
				}
				try { resolve(JSON.parse(data || '{}')); } catch { resolve({ raw: data }); }
			});
		});
		req.on('error', reject);
		req.on('timeout', () => { req.destroy(new Error('Aria memory server timeout')); });
		req.write(payload);
		req.end();
	});
}

/**
 * Store a cross-project user fact. `infer: false` stores it as-is: the
 * extraction/judgment was already done by the user's own provider (the agent
 * that decided this is a durable cross-project fact and called this tool), so
 * mem0's server-side LLM does NOT re-extract — one extraction pass, consistent
 * with the project wiki.
 */
export async function rememberUser(content: string, metadata?: Record<string, unknown>): Promise<unknown> {
	const token = await authToken();
	return postJson('/api/memory/add', { content, infer: false, metadata: metadata ?? {} }, token);
}

/** Semantic recall of the user's cross-project memory. */
export async function recallUser(query: string, limit = 5): Promise<Array<{ memory?: string; score?: number }>> {
	const token = await authToken();
	const res = await postJson('/api/memory/search', { query, limit }, token) as
		| { results?: Array<{ memory?: string; score?: number }> }
		| Array<{ memory?: string; score?: number }>;
	if (Array.isArray(res)) {
		return res;
	}
	return res.results ?? [];
}
