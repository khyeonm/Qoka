/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as http from 'http';
import * as https from 'https';
import { URL } from 'url';
import type { AddressInfo } from 'net';

/**
 * Authentication provider for Aria - ORCID / Google sign-in via the Aria backend.
 *
 * Flow (localhost loopback - reliable on every OS, no URI-scheme registration):
 *   createSession() → start a throwaway HTTP server on 127.0.0.1:<port> → open the
 *   system browser at `<server>/auth/app-login?provider=<p>&port=<port>` → allauth
 *   runs OAuth and logs the user in → the backend redirects the browser to
 *   `http://127.0.0.1:<port>/callback?access=…&refresh=…&user_id=…` → our local
 *   server catches it, we store the JWT in SecretStorage and return a session.
 *
 * A custom `aria://` scheme was tried first but does not work in source/dev builds
 * on Linux (the OS has no handler registered → the browser hands it to xdg-open,
 * which fails). The loopback avoids all of that.
 *
 * The account id is the backend's internal UUID (the same value used as the mem0
 * `user_id`), so recall/remember on the server is scoped to this user.
 */

const SECRET_KEY = 'aria.auth.session';
const SERVER_URL = process.env.ARIA_SERVER_URL || 'https://aria.pnucolab.com';
// The lab server may use a self-signed cert (Caddy `tls internal`); allow it by
// default. Set ARIA_INSECURE_TLS=0 to enforce strict verification.
const ALLOW_SELF_SIGNED = process.env.ARIA_INSECURE_TLS !== '0';
// Refresh the access token when it's within this many seconds of expiry. Large
// (12h) so a periodic background check comfortably renews it well before the
// 7-day access token would ever expire - the user shouldn't notice.
const REFRESH_SKEW_SEC = 12 * 60 * 60;

/** Read the `exp` (unix seconds) claim from a JWT without verifying it. */
function jwtExp(token: string): number | undefined {
	try {
		const part = token.split('.')[1];
		const json = Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
		const exp = JSON.parse(json).exp;
		return typeof exp === 'number' ? exp : undefined;
	} catch {
		return undefined;
	}
}

interface StoredSession {
	id: string;
	access: string;
	refresh: string;
	userId: string;
	email: string;
	name: string;
	provider: string; // 'orcid' | 'google'
}

export class AriaAuthProvider implements vscode.AuthenticationProvider, vscode.Disposable {

	private readonly _onDidChangeSessions =
		new vscode.EventEmitter<vscode.AuthenticationProviderAuthenticationSessionsChangeEvent>();
	readonly onDidChangeSessions = this._onDidChangeSessions.event;

	constructor(private readonly secrets: vscode.SecretStorage) { }

	dispose(): void {
		this._onDidChangeSessions.dispose();
	}

	async getSessions(_scopes?: readonly string[]): Promise<vscode.AuthenticationSession[]> {
		let stored = await this._read();
		if (!stored) {
			return [];
		}
		// Transparently refresh the access token if it's expired / about to expire,
		// using the (30-day) refresh token. The user only re-signs-in when the
		// refresh token itself expires.
		const exp = jwtExp(stored.access);
		const now = Math.floor(Date.now() / 1000);
		if (exp === undefined || exp - now < REFRESH_SKEW_SEC) {
			const newAccess = await this._refreshAccess(stored.refresh);
			if (newAccess) {
				stored = { ...stored, access: newAccess };
				await this._write(stored);
			} else if (exp !== undefined && exp <= now) {
				// Access token is truly expired and refresh failed (refresh token
				// expired/invalid) → treat as signed out and tell the user why,
				// so a silent failure doesn't leave them confused.
				const old = this._toSession(stored);
				await this.secrets.delete(SECRET_KEY);
				this._onDidChangeSessions.fire({ added: [], removed: [old], changed: [] });
				this._promptReSignIn();
				return [];
			}
			// else: refresh failed but the current token is still valid - keep using it.
		}
		return [this._toSession(stored)];
	}

	private _reSignInPromptShown = false;

	/** Session expired and couldn't be refreshed → surface a clear, actionable
	 *  prompt instead of a silent failure the user can't diagnose. */
	private _promptReSignIn(): void {
		if (this._reSignInPromptShown) {
			return;
		}
		this._reSignInPromptShown = true;
		// A modal (center-screen) dialog rather than a corner toast or status-bar
		// item, so an expired session can't fail silently and unnoticed.
		void vscode.window.showWarningMessage(
			'Sign in to Aria',
			{
				modal: true,
				detail: 'Your Aria sign-in has expired. Sign in again to keep your cross-project memory working.',
			},
			'Sign in',
		).then(choice => {
			this._reSignInPromptShown = false;
			if (choice === 'Sign in') {
				// Opens the provider picker → browser sign-in (loopback), then stores
				// a fresh session. The user's current folder is preserved.
				void vscode.authentication.getSession('aria', [], { createIfNone: true });
			}
		});
	}

	/** POST the refresh token to the backend; returns a fresh access token or undefined. */
	private _refreshAccess(refresh: string): Promise<string | undefined> {
		return new Promise(resolve => {
			try {
				const url = new URL('/api/token/refresh', SERVER_URL);
				const payload = JSON.stringify({ refresh });
				const isHttps = url.protocol === 'https:';
				const lib = isHttps ? https : http;
				const options: https.RequestOptions = {
					method: 'POST',
					headers: {
						'content-type': 'application/json',
						'content-length': Buffer.byteLength(payload),
					},
					timeout: 15000,
				};
				if (isHttps && ALLOW_SELF_SIGNED) {
					options.rejectUnauthorized = false;
				}
				const req = lib.request(url, options, res => {
					let data = '';
					res.on('data', c => { data += c; });
					res.on('end', () => {
						const code = res.statusCode ?? 0;
						if (code < 200 || code >= 300) { resolve(undefined); return; }
						try {
							const access = JSON.parse(data).access;
							resolve(typeof access === 'string' ? access : undefined);
						} catch { resolve(undefined); }
					});
				});
				req.on('error', () => resolve(undefined));
				req.on('timeout', () => { req.destroy(); resolve(undefined); });
				req.write(payload);
				req.end();
			} catch {
				resolve(undefined);
			}
		});
	}

	/** The raw stored session (incl. provider/name), for the status bar UI. */
	async currentSession(): Promise<{ name: string; email: string; provider: string } | undefined> {
		const s = await this._read();
		return s ? { name: s.name, email: s.email, provider: s.provider } : undefined;
	}

	async createSession(scopes: readonly string[]): Promise<vscode.AuthenticationSession> {
		// The login gate passes the provider as a scope ('orcid' | 'google') to
		// skip the picker; a bare call (e.g. Command Palette) falls back to it.
		let providerId: string | undefined = scopes.find(s => s === 'orcid' || s === 'google');
		if (!providerId) {
			const pick = await vscode.window.showQuickPick(
				[
					{ label: 'ORCID', id: 'orcid' },
					{ label: 'Google', id: 'google' },
				],
				{ title: 'Sign in to Aria', placeHolder: 'Choose how to sign in' },
			);
			if (!pick) {
				throw new Error('Aria sign-in cancelled.');
			}
			providerId = pick.id;
		}

		// Show a cancellable notification while we wait for the browser callback,
		// so a user who changes their mind or closes the tab can Cancel and get
		// the sign-in screen back at once (the loopback otherwise waits 5 min).
		const callback = await vscode.window.withProgress(
			{ location: vscode.ProgressLocation.Notification, title: 'Finish signing in to Aria in your browser, or Cancel to go back…', cancellable: true },
			(_progress, token) => this._loopbackLogin(providerId, token),
		);

		const q = new URLSearchParams(callback.query);
		const access = q.get('access');
		const refresh = q.get('refresh');
		const userId = q.get('user_id') ?? '';
		const email = q.get('email') ?? '';
		const name = q.get('name') ?? '';
		if (!access || !refresh) {
			throw new Error('Aria sign-in failed: no token in the callback.');
		}

		const stored: StoredSession = { id: userId || access.slice(0, 16), access, refresh, userId, email, name, provider: providerId };
		await this._write(stored);
		const session = this._toSession(stored);
		this._onDidChangeSessions.fire({ added: [session], removed: [], changed: [] });
		return session;
	}

	async removeSession(_sessionId: string): Promise<void> {
		const stored = await this._read();
		await this.secrets.delete(SECRET_KEY);
		if (stored) {
			this._onDidChangeSessions.fire({ added: [], removed: [this._toSession(stored)], changed: [] });
		}
	}

	// --- helpers ------------------------------------------------------------

	/**
	 * Spin up a one-shot HTTP server on an ephemeral loopback port, open the
	 * browser at the backend's app-login URL (carrying that port), and resolve
	 * with the `/callback?…tokens…` URI the backend redirects the browser to.
	 */
	/** Set while a loopback login is waiting for the browser callback; calling it
	 *  aborts that login (closes the server, rejects createSession). Consumed by
	 *  the `aria.auth.cancelSignIn` command. */
	private _activeLoginCancel: (() => void) | undefined;

	/** Abort an in-flight sign-in (if any). Safe to call when none is running. */
	cancelActiveLogin(): void {
		this._activeLoginCancel?.();
	}

	private _loopbackLogin(providerId: string, token?: vscode.CancellationToken): Promise<vscode.Uri> {
		return new Promise<vscode.Uri>((resolve, reject) => {
			const server = http.createServer((req, res) => {
				const reqUrl = req.url || '/';
				if (!reqUrl.startsWith('/callback')) {
					res.writeHead(404, { 'Content-Type': 'text/plain' });
					res.end('Not found');
					return;
				}
				res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
				res.end(
					'<!doctype html><meta charset="utf-8">' +
					'<body style="font-family:system-ui,sans-serif;text-align:center;padding-top:64px;color:#222">' +
					'<h2>&#10003; Signed in to Aria</h2>' +
					'<p>You can close this tab and return to Aria.</p>' +
					// Best-effort auto-close. Browsers only honour window.close() for
					// script-opened tabs, so this may be a no-op - the message above is
					// the fallback.
					'<script>setTimeout(function(){try{window.close();}catch(e){}},300);</script>' +
					'</body>',
				);
				cleanup();
				resolve(vscode.Uri.parse(`http://127.0.0.1${reqUrl}`));
			});

			const timer = setTimeout(() => {
				cleanup();
				reject(new Error('Aria sign-in timed out.'));
			}, 5 * 60 * 1000);

			const cleanup = () => {
				clearTimeout(timer);
				this._activeLoginCancel = undefined;
				try { server.close(); } catch { /* ignore */ }
			};

			// Expose a cancel hook so the workbench (the Started overlay's "Back to
			// sign-in" button) can abort THIS login even though the browser fired no
			// event - otherwise the loopback server and its withProgress notification
			// linger, and a following sign-in with a different provider can't proceed.
			this._activeLoginCancel = () => {
				cleanup();
				reject(new Error('Aria sign-in cancelled.'));
			};

			// Let the user bail out (changed their mind, closed the browser tab)
			// and return to the sign-in screen immediately instead of waiting out
			// the 5-minute timeout.
			token?.onCancellationRequested(() => {
				cleanup();
				reject(new Error('Aria sign-in cancelled.'));
			});

			server.on('error', err => { cleanup(); reject(err); });

			server.listen(0, '127.0.0.1', () => {
				const port = (server.address() as AddressInfo).port;
				const loginUrl = vscode.Uri.parse(`${SERVER_URL}/auth/app-login?provider=${providerId}&port=${port}`);
				void Promise.resolve(vscode.env.openExternal(loginUrl)).then(ok => {
					if (!ok) {
						cleanup();
						reject(new Error('Could not open the browser for sign-in.'));
					}
				});
			});
		});
	}

	private _toSession(s: StoredSession): vscode.AuthenticationSession {
		return {
			id: s.id,
			accessToken: s.access,
			account: { id: s.userId, label: s.name || s.email || s.userId || 'Aria user' },
			// Empty scopes: other extensions (e.g. aria-memory) look up the token
			// with getSession('aria', []), which only matches a session whose
			// scopes are also []. The login provider is surfaced separately via
			// AriaAuthProvider.currentSession() (the status-bar item), not scopes.
			scopes: [],
		};
	}

	private async _read(): Promise<StoredSession | undefined> {
		const raw = await this.secrets.get(SECRET_KEY);
		if (!raw) { return undefined; }
		try { return JSON.parse(raw) as StoredSession; } catch { return undefined; }
	}

	private async _write(s: StoredSession): Promise<void> {
		await this.secrets.store(SECRET_KEY, JSON.stringify(s));
	}
}
