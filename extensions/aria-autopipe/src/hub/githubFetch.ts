/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as https from 'https';

export interface GitTreeEntry {
	path: string;
	mode: string;
	entry_type: 'blob' | 'tree';
	sha: string;
	size?: number;
}

interface ParsedRef {
	owner: string;
	repo: string;
	ref: string;
	/** Empty string when the URL points at the repo root; otherwise the
	 *  path inside the repo (no leading or trailing slash). Pipelines on
	 *  Hub commonly live in monorepos under e.g. `pipelines/<name>/`. */
	subPath: string;
}

function parseTreeUrl(treeUrl: string): ParsedRef {
	// Accepted forms:
	//   https://github.com/owner/repo
	//   https://github.com/owner/repo/tree/<ref>
	//   https://github.com/owner/repo/tree/<ref>/<sub/path/inside/repo>
	//
	// The trailing component captures any number of path segments under
	// the ref so monorepo pipelines (e.g. `tree/main/pipelines/foo`)
	// don't get rejected as "unrecognized" the way the single-segment
	// pattern used to.
	const m = treeUrl.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?(?:\/tree\/([^/?#]+)(?:\/([^?#]+))?)?\/?(?:[?#].*)?$/);
	if (!m) {
		throw new Error(`Unrecognized GitHub URL: ${treeUrl}`);
	}
	const subPath = (m[4] || '').replace(/\/+$/, '');
	return { owner: m[1], repo: m[2], ref: m[3] || 'main', subPath };
}

function ghHeaders(token?: string): https.RequestOptions['headers'] {
	const h: Record<string, string> = {
		'Accept': 'application/vnd.github+json',
		'User-Agent': 'aria-autopipe',
	};
	if (token) {
		h.Authorization = `Bearer ${token}`;
	}
	return h;
}

function getJson<T>(url: string, token?: string): Promise<T> {
	return new Promise((resolve, reject) => {
		const fetch = (u: string, redirectsLeft: number) => {
			https.get(u, { headers: ghHeaders(token) }, (res) => {
				if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
					if (redirectsLeft <= 0) {
						reject(new Error('Too many redirects'));
						return;
					}
					fetch(res.headers.location, redirectsLeft - 1);
					return;
				}
				let body = '';
				res.setEncoding('utf8');
				res.on('data', (c) => { body += c; });
				res.on('end', () => {
					if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
						reject(new Error(`GitHub API ${res.statusCode}: ${body.slice(0, 200)}`));
						return;
					}
					try {
						resolve(JSON.parse(body) as T);
					} catch (err) {
						reject(err as Error);
					}
				});
			}).on('error', reject);
		};
		fetch(url, 5);
	});
}

function getText(url: string, token?: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const fetch = (u: string, redirectsLeft: number) => {
			https.get(u, { headers: ghHeaders(token) }, (res) => {
				if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
					if (redirectsLeft <= 0) {
						reject(new Error('Too many redirects'));
						return;
					}
					fetch(res.headers.location, redirectsLeft - 1);
					return;
				}
				let body = '';
				res.setEncoding('utf8');
				res.on('data', (c) => { body += c; });
				res.on('end', () => {
					if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
						reject(new Error(`GitHub raw ${res.statusCode}: ${body.slice(0, 200)}`));
						return;
					}
					resolve(body);
				});
			}).on('error', reject);
		};
		fetch(url, 5);
	});
}

/**
 * Fetch the recursive file tree for a pipeline's GitHub repo+ref. When the
 * URL points into a subdirectory (e.g. `tree/main/pipelines/foo`) we still
 * fetch the full tree from GitHub (the API doesn't accept sub-paths
 * directly), then prune to entries below the subdirectory and strip the
 * common prefix so the UI shows paths relative to the pipeline root.
 */
export async function fetchGitHubTree(githubUrl: string, token?: string): Promise<GitTreeEntry[]> {
	const { owner, repo, ref, subPath } = parseTreeUrl(githubUrl);
	type ApiResponse = {
		tree: Array<{ path: string; mode: string; type: 'blob' | 'tree'; sha: string; size?: number }>;
		truncated?: boolean;
	};
	const data = await getJson<ApiResponse>(
		`https://api.github.com/repos/${owner}/${repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`,
		token,
	);
	let tree = data.tree ?? [];
	if (subPath) {
		const prefix = subPath + '/';
		tree = tree
			.filter(e => e.path === subPath || e.path.startsWith(prefix))
			// Drop the subPath itself; rebase descendants so the UI sees
			// pipeline-relative paths instead of repo-absolute ones.
			.filter(e => e.path !== subPath)
			.map(e => ({ ...e, path: e.path.slice(prefix.length) }));
	}
	return tree.map(e => ({
		path: e.path,
		mode: e.mode,
		entry_type: e.type,
		sha: e.sha,
		size: e.size,
	}));
}

/**
 * Fetch the raw text content of a single file at the given ref. The
 * `filePath` argument is pipeline-relative; we re-prefix it with the URL's
 * subPath before hitting `raw.githubusercontent.com` so monorepo pipelines
 * resolve to the right blob.
 */
export async function fetchGitHubFile(githubUrl: string, filePath: string, token?: string): Promise<string> {
	const { owner, repo, ref, subPath } = parseTreeUrl(githubUrl);
	const fullPath = subPath ? `${subPath}/${filePath}` : filePath;
	return getText(`https://raw.githubusercontent.com/${owner}/${repo}/${encodeURIComponent(ref)}/${fullPath.split('/').map(encodeURIComponent).join('/')}`, token);
}
