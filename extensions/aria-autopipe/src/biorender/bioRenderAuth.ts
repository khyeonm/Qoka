/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as http from 'http';
import * as crypto from 'crypto';

/**
 * BioRender MCP OAuth (RFC 8252 loopback + PKCE + dynamic client registration).
 *
 * The BioRender MCP server (`https://mcp.services.biorender.com/mcp`) is a
 * standard OAuth 2.1 protected resource: dynamic client registration at
 * `/oauth/register`, authorization-code + PKCE at `/oauth/authorize`, tokens at
 * `/oauth/token`, and `offline_access` for a refresh token. Qoka owns the token
 * itself (rather than delegating to the AI CLI's `/mcp` auth) so the whole login
 * is a single Settings button and the token can be injected into BOTH providers'
 * MCP config as an `Authorization: Bearer` header - i.e. the chat session then
 * uses BioRender as the signed-in user's own account.
 *
 * Tokens live in the extension's SecretStorage, never on any Qoka server.
 */

export const BIORENDER_MCP_URL = 'https://mcp.services.biorender.com/mcp';
const BASE = 'https://mcp.services.biorender.com';
const AUTHORIZE_URL = `${BASE}/oauth/authorize`;
const TOKEN_URL = `${BASE}/oauth/token`;
const REGISTER_URL = `${BASE}/oauth/register`;
const SCOPE = 'openid profile email offline_access';

const SECRET_CLIENT = 'aria.biorender.client';
const SECRET_TOKENS = 'aria.biorender.tokens';

interface StoredClient { client_id: string; client_secret?: string; }
interface StoredTokens { access_token: string; refresh_token?: string; expires_at: number; account?: string }

export interface BioRenderStatus { connected: boolean; account?: string }

function b64url(buf: Buffer): string {
	return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export class BioRenderAuthService {
	constructor(private readonly secrets: vscode.SecretStorage) { }

	async getStatus(): Promise<BioRenderStatus> {
		const t = await this.readTokens();
		return { connected: !!t, account: t?.account };
	}

	async isConnected(): Promise<boolean> {
		return !!(await this.readTokens());
	}

	/** A valid access token, refreshing if it is expired. Null when not logged
	 *  in, or when a refresh fails (the caller should surface "re-login"). */
	async getValidAccessToken(): Promise<string | null> {
		const t = await this.readTokens();
		if (!t) { return null; }
		if (Date.now() < t.expires_at - 60_000) { return t.access_token; }
		if (!t.refresh_token) { return null; }
		try {
			const client = await this.readClient();
			if (!client) { return null; }
			const refreshed = await this.exchangeRefresh(client, t.refresh_token, t.account);
			await this.writeTokens(refreshed);
			return refreshed.access_token;
		} catch (err) {
			console.warn('[aria-autopipe] BioRender token refresh failed:', (err as Error).message);
			return null;
		}
	}

	async logout(): Promise<void> {
		await this.secrets.delete(SECRET_TOKENS);
		// Keep the registered client so a later login reuses it without a second DCR.
	}

	/** Full interactive login: DCR (with a fresh loopback redirect) -> browser
	 *  authorize -> code -> token. Resolves with the connected account. */
	async login(): Promise<{ ok: boolean; message: string; account?: string }> {
		let server: http.Server | undefined;
		try {
			// 1) Loopback callback server on an ephemeral port.
			const { srv, port, wait } = await this.startLoopback();
			server = srv;
			const redirectUri = `http://127.0.0.1:${port}/callback`;

			// 2) Dynamic client registration for THIS redirect (cheap; reused for refresh).
			const client = await this.registerClient(redirectUri);
			await this.writeClient(client);

			// 3) PKCE + state, open the browser at the authorize endpoint.
			const verifier = b64url(crypto.randomBytes(32));
			const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
			const state = crypto.randomBytes(16).toString('hex');
			const authUrl = new URL(AUTHORIZE_URL);
			authUrl.searchParams.set('response_type', 'code');
			authUrl.searchParams.set('client_id', client.client_id);
			authUrl.searchParams.set('redirect_uri', redirectUri);
			authUrl.searchParams.set('scope', SCOPE);
			authUrl.searchParams.set('state', state);
			authUrl.searchParams.set('code_challenge', challenge);
			authUrl.searchParams.set('code_challenge_method', 'S256');
			await vscode.env.openExternal(vscode.Uri.parse(authUrl.toString()));

			// 4) Wait for the redirect (5 min budget), verify state.
			const cb = await wait;
			if (cb.state !== state) { throw new Error('OAuth state mismatch'); }
			if (!cb.code) { throw new Error(cb.error || 'No authorization code returned'); }

			// 5) Exchange code -> tokens.
			const tokens = await this.exchangeCode(client, cb.code, verifier, redirectUri);
			await this.writeTokens(tokens);
			return { ok: true, message: 'Connected to BioRender.', account: tokens.account };
		} catch (err) {
			return { ok: false, message: `BioRender login failed: ${(err as Error).message}` };
		} finally {
			try { server?.close(); } catch { /* ignore */ }
		}
	}

	// --- internals ---

	private startLoopback(): Promise<{ srv: http.Server; port: number; wait: Promise<{ code?: string; state?: string; error?: string }> }> {
		return new Promise((resolve, reject) => {
			let settle: (v: { code?: string; state?: string; error?: string }) => void;
			const wait = new Promise<{ code?: string; state?: string; error?: string }>((res) => { settle = res; });
			const timeout = setTimeout(() => settle({ error: 'Login timed out (5 minutes)' }), 5 * 60_000);
			const srv = http.createServer((req, res) => {
				try {
					const u = new URL(req.url || '/', 'http://127.0.0.1');
					if (u.pathname !== '/callback') { res.writeHead(404); res.end(); return; }
					clearTimeout(timeout);
					res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
					res.end('<!doctype html><meta charset="utf-8"><body style="font-family:system-ui;padding:40px"><h2>BioRender connected</h2><p>You can close this tab and return to Qoka.</p></body>');
					settle({ code: u.searchParams.get('code') ?? undefined, state: u.searchParams.get('state') ?? undefined, error: u.searchParams.get('error') ?? undefined });
				} catch (e) {
					res.writeHead(500); res.end(); settle({ error: (e as Error).message });
				}
			});
			srv.on('error', reject);
			srv.listen(0, '127.0.0.1', () => {
				const addr = srv.address();
				if (addr && typeof addr === 'object') { resolve({ srv, port: addr.port, wait }); }
				else { reject(new Error('Failed to bind loopback callback server')); }
			});
		});
	}

	private async registerClient(redirectUri: string): Promise<StoredClient> {
		const res = await fetch(REGISTER_URL, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				client_name: 'Qoka',
				redirect_uris: [redirectUri],
				grant_types: ['authorization_code', 'refresh_token'],
				response_types: ['code'],
				token_endpoint_auth_method: 'client_secret_post',
				scope: SCOPE,
			}),
		});
		if (!res.ok) { throw new Error(`client registration failed: ${res.status}`); }
		const body = await res.json() as Record<string, unknown>;
		const clientId = body.client_id as string | undefined;
		if (!clientId) { throw new Error('no client_id in registration response'); }
		return { client_id: clientId, client_secret: body.client_secret as string | undefined };
	}

	private async exchangeCode(client: StoredClient, code: string, verifier: string, redirectUri: string): Promise<StoredTokens> {
		const form = new URLSearchParams({
			grant_type: 'authorization_code',
			code,
			redirect_uri: redirectUri,
			code_verifier: verifier,
			client_id: client.client_id,
		});
		if (client.client_secret) { form.set('client_secret', client.client_secret); }
		return this.tokenRequest(form);
	}

	private async exchangeRefresh(client: StoredClient, refreshToken: string, prevAccount?: string): Promise<StoredTokens> {
		const form = new URLSearchParams({
			grant_type: 'refresh_token',
			refresh_token: refreshToken,
			client_id: client.client_id,
		});
		if (client.client_secret) { form.set('client_secret', client.client_secret); }
		const t = await this.tokenRequest(form);
		// A refresh response may omit the account claim; keep the known one.
		if (!t.account) { t.account = prevAccount; }
		if (!t.refresh_token) { t.refresh_token = refreshToken; }
		return t;
	}

	private async tokenRequest(form: URLSearchParams): Promise<StoredTokens> {
		const res = await fetch(TOKEN_URL, {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
			body: form.toString(),
		});
		const body = await res.json().catch(() => ({})) as Record<string, unknown>;
		if (!res.ok) { throw new Error(`token endpoint ${res.status}: ${(body.error_description as string) || (body.error as string) || res.statusText}`); }
		const accessToken = body.access_token as string | undefined;
		if (!accessToken) { throw new Error('no access_token in token response'); }
		const expiresIn = typeof body.expires_in === 'number' ? body.expires_in : 3600;
		return {
			access_token: accessToken,
			refresh_token: body.refresh_token as string | undefined,
			expires_at: Date.now() + expiresIn * 1000,
			account: this.accountFromIdToken(body.id_token as string | undefined),
		};
	}

	/** Best-effort display name from the OIDC id_token (email/preferred_username).
	 *  No signature verification - it is only used to label the Settings row. */
	private accountFromIdToken(idToken?: string): string | undefined {
		if (!idToken) { return undefined; }
		try {
			const payload = idToken.split('.')[1];
			if (!payload) { return undefined; }
			const json = JSON.parse(Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')) as Record<string, unknown>;
			return (json.email as string) || (json.preferred_username as string) || (json.name as string) || undefined;
		} catch {
			return undefined;
		}
	}

	private async readClient(): Promise<StoredClient | undefined> {
		const raw = await this.secrets.get(SECRET_CLIENT);
		if (!raw) { return undefined; }
		try { return JSON.parse(raw) as StoredClient; } catch { return undefined; }
	}
	private async writeClient(c: StoredClient): Promise<void> {
		await this.secrets.store(SECRET_CLIENT, JSON.stringify(c));
	}
	private async readTokens(): Promise<StoredTokens | undefined> {
		const raw = await this.secrets.get(SECRET_TOKENS);
		if (!raw) { return undefined; }
		try { return JSON.parse(raw) as StoredTokens; } catch { return undefined; }
	}
	private async writeTokens(t: StoredTokens): Promise<void> {
		await this.secrets.store(SECRET_TOKENS, JSON.stringify(t));
	}
}
