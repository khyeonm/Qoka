/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * GitHub OAuth Device Flow — no browser callback needed, just shows a code
 * the user types into github.com/login/device. Mirrors the same flow
 * autopipe-app implements in `crates/desktop/src/github.rs`.
 *
 * The CLIENT_ID is the public identifier for Aria's GitHub OAuth App; it
 * needs no secret because Device Flow is designed for installed apps.
 * Plug a real CLIENT_ID in here before shipping — the placeholder below
 * lets the type-check pass but won't actually authenticate.
 */

// Aria reuses autopipe-app's registered GitHub OAuth App so we don't have
// to maintain a separate one. The OAuth App represents Aria/autopipe to
// GitHub; the access tokens it produces are scoped per-user.
const ARIA_GITHUB_CLIENT_ID = 'Ov23licUjPEZraXFIpvR';

const DEVICE_CODE_URL = 'https://github.com/login/device/code';
const ACCESS_TOKEN_URL = 'https://github.com/login/oauth/access_token';
// `repo` to clone/push pipeline repos, `read:user` for commit attribution.
// Matches the scope autopipe-app requests so a user who already authorized
// the app for autopipe-app doesn't see a second consent screen here.
const SCOPE = 'repo,read:user';

export interface DeviceFlowStart {
	device_code: string;
	user_code: string;
	verification_uri: string;
	expires_in: number;
	interval: number;
}

export interface PollResult {
	status: 'pending' | 'authorized' | 'expired' | 'denied' | 'slow_down' | 'error';
	token?: string;
	login?: string;
	message?: string;
}

export class GitHubAuthService {

	async startDeviceFlow(): Promise<DeviceFlowStart> {
		const res = await fetch(DEVICE_CODE_URL, {
			method: 'POST',
			headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
			body: JSON.stringify({ client_id: ARIA_GITHUB_CLIENT_ID, scope: SCOPE }),
		});
		if (!res.ok) {
			throw new Error(`startDeviceFlow failed: ${res.status} ${res.statusText}`);
		}
		return await res.json() as DeviceFlowStart;
	}

	async pollForToken(deviceCode: string): Promise<PollResult> {
		const res = await fetch(ACCESS_TOKEN_URL, {
			method: 'POST',
			headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
			body: JSON.stringify({
				client_id: ARIA_GITHUB_CLIENT_ID,
				device_code: deviceCode,
				grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
			}),
		});
		if (!res.ok) {
			return { status: 'error', message: `HTTP ${res.status}` };
		}
		const body = await res.json() as Record<string, unknown>;
		const errorCode = body.error as string | undefined;
		if (errorCode === 'authorization_pending') {
			return { status: 'pending' };
		}
		if (errorCode === 'slow_down') {
			return { status: 'slow_down' };
		}
		if (errorCode === 'expired_token') {
			return { status: 'expired' };
		}
		if (errorCode === 'access_denied') {
			return { status: 'denied' };
		}
		if (errorCode) {
			return { status: 'error', message: errorCode };
		}
		const token = body.access_token as string | undefined;
		if (!token) {
			return { status: 'error', message: 'no token in response' };
		}
		// Look up the user's login so we can store it alongside the token —
		// the upload flow needs it to attribute commits.
		const login = await this.fetchLogin(token).catch(() => undefined);
		return { status: 'authorized', token, login };
	}

	async fetchLogin(token: string): Promise<string> {
		const res = await fetch('https://api.github.com/user', {
			headers: { 'Authorization': `token ${token}`, 'Accept': 'application/vnd.github+json' },
		});
		if (!res.ok) {
			throw new Error(`/user → ${res.status}`);
		}
		const body = await res.json() as Record<string, unknown>;
		const login = body.login as string | undefined;
		if (!login) {
			throw new Error('no login in /user response');
		}
		return login;
	}
}
