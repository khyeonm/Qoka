/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * GitHub helpers. Ports `parse_github_url`, `fetch_github_login`,
 * `fetch_github_file`, `fill_ro_crate_author`, `is_code_review_target`,
 * and `fetch_pipeline_code_dump` from autopipe-app's `mcp/server.rs`.
 *
 * These mirror the Rust signatures and error handling closely so the
 * MCP tool ports can read like the Rust code with minimal translation.
 */

export interface ParsedGithubUrl {
	owner: string;
	repo: string;
	/** Branch or tag in `tree/<ref>/...`; null if URL has no tree segment. */
	branch: string | null;
	/** Sub-path inside the repo (`tree/<ref>/<sub/path>`); empty string when at root. */
	path: string;
}

/**
 * Parse a GitHub URL into (owner, repo, branch_or_tag, subpath).
 * Returns null when the URL doesn't look like a github.com URL.
 *
 * Supported shapes:
 *   https://github.com/{owner}/{repo}
 *   https://github.com/{owner}/{repo}/tree/{branch}/{path/maybe/deep}
 */
export function parseGithubUrl(url: string): ParsedGithubUrl | null {
	const trimmed = url.trim().replace(/\/+$/, '');
	const stripped = trimmed.startsWith('https://github.com/')
		? trimmed.slice('https://github.com/'.length)
		: trimmed.startsWith('http://github.com/')
			? trimmed.slice('http://github.com/'.length)
			: null;
	if (stripped === null) {
		return null;
	}
	// splitn(4, '/') in Rust → at most 4 parts; keeps the rest after tree/<ref>/ as one chunk.
	const parts: string[] = [];
	let remaining = stripped;
	for (let i = 0; i < 3; i++) {
		const idx = remaining.indexOf('/');
		if (idx === -1) {
			parts.push(remaining);
			remaining = '';
			break;
		}
		parts.push(remaining.slice(0, idx));
		remaining = remaining.slice(idx + 1);
	}
	if (remaining) {
		parts.push(remaining);
	}
	if (parts.length < 2) {
		return null;
	}
	const owner = parts[0];
	const repo = parts[1];
	if (parts.length >= 4 && parts[2] === 'tree') {
		const rest = parts[3];
		const slashPos = rest.indexOf('/');
		if (slashPos >= 0) {
			return { owner, repo, branch: rest.slice(0, slashPos), path: rest.slice(slashPos + 1) };
		}
		return { owner, repo, branch: rest, path: '' };
	}
	return { owner, repo, branch: null, path: '' };
}

/**
 * Best-effort fetch of the authenticated GitHub login. Returns null on
 * missing/empty token, network error, or non-2xx response.
 */
export async function fetchGithubLogin(token: string | undefined | null): Promise<string | null> {
	if (!token) {
		return null;
	}
	try {
		const res = await fetch('https://api.github.com/user', {
			headers: {
				'Authorization': `Bearer ${token}`,
				'User-Agent': 'aria-autopipe',
			},
		});
		if (!res.ok) {
			return null;
		}
		const body = (await res.json()) as { login?: string };
		return typeof body.login === 'string' ? body.login : null;
	} catch {
		return null;
	}
}

/**
 * Fetch a single file from GitHub Contents API. Returns the raw text or
 * null when the request fails / returns non-2xx.
 */
export async function fetchGithubFile(
	owner: string,
	repo: string,
	path: string,
	token: string | undefined | null,
): Promise<string | null> {
	const encodedPath = path.split('/').map(seg => seg.replace(/ /g, '%20')).join('/');
	const url = `https://api.github.com/repos/${owner}/${repo}/contents/${encodedPath}`;
	const headers: Record<string, string> = {
		'Accept': 'application/vnd.github.raw',
		'User-Agent': 'aria-autopipe',
	};
	if (token) {
		headers.Authorization = `Bearer ${token}`;
	}
	try {
		const res = await fetch(url, { headers });
		if (!res.ok) {
			return null;
		}
		return await res.text();
	} catch {
		return null;
	}
}

/**
 * Walk the `@graph` array in a parsed ro-crate-metadata.json and set the
 * Person `#author` node's `name` to `login`. Returns pretty-printed JSON.
 * Throws on parse failure (matches Rust's Result<String, String>).
 */
export function fillRoCrateAuthor(content: string, login: string): string {
	let parsed: unknown;
	try {
		parsed = JSON.parse(content);
	} catch (err) {
		throw new Error(`parse: ${(err as Error).message}`);
	}
	const v = parsed as { '@graph'?: Array<Record<string, unknown>> };
	const graph = v['@graph'];
	if (!Array.isArray(graph)) {
		throw new Error('@graph is not an array');
	}
	for (const node of graph) {
		if (node['@id'] === '#author') {
			node.name = login;
		}
	}
	return JSON.stringify(v, null, 2);
}

/**
 * True iff the path looks like a source/config file an AI should review
 * before a pipeline download. Permissive on obvious source code, strict
 * on binary data. Mirrors `is_code_review_target` in Rust.
 */
export function isCodeReviewTarget(path: string): boolean {
	const lower = path.toLowerCase();
	const slashIdx = lower.lastIndexOf('/');
	const basename = slashIdx >= 0 ? lower.slice(slashIdx + 1) : lower;
	if (basename === 'snakefile' || basename === 'dockerfile' || basename === 'makefile') {
		return true;
	}
	const EXTS = [
		'.py', '.r', '.rmd', '.sh', '.bash', '.zsh', '.yaml', '.yml',
		'.json', '.jsonl', '.toml', '.md', '.txt', '.ipynb', '.sql',
		'.pl', '.rb', '.js', '.ts',
	];
	return EXTS.some(e => lower.endsWith(e));
}

/**
 * Fetch every reviewable source/config file from the pipeline's GitHub
 * directory and assemble a single textual dump for the calling AI. Adds
 * an `INSTRUCTIONS FOR AI` footer that tells the agent how to proceed.
 *
 * Mirrors `fetch_pipeline_code_dump` from autopipe-app: GitHub Trees API
 * → filter blobs under `subpath` matching `is_code_review_target` →
 * raw.githubusercontent.com for each file → concatenated dump.
 */
export async function fetchPipelineCodeDump(
	owner: string,
	repo: string,
	branch: string,
	subpath: string,
	token: string | undefined | null,
): Promise<string> {
	// 1) Tree listing
	const treeUrl = `https://api.github.com/repos/${owner}/${repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`;
	const treeHeaders: Record<string, string> = { 'User-Agent': 'aria-autopipe' };
	if (token) {
		treeHeaders.Authorization = `Bearer ${token}`;
	}
	const treeResp = await fetch(treeUrl, { headers: treeHeaders });
	if (!treeResp.ok) {
		throw new Error(`GitHub tree fetch failed: HTTP ${treeResp.status}`);
	}
	const treeBody = (await treeResp.json()) as { tree?: Array<{ type?: string; path?: string }> };
	const tree = treeBody.tree;
	if (!Array.isArray(tree)) {
		throw new Error("GitHub tree response missing 'tree' array");
	}

	// 2) Filter
	const normalised = subpath.replace(/^\/+|\/+$/g, '');
	const prefix = normalised ? `${normalised}/` : '';
	const targets: string[] = [];
	for (const entry of tree) {
		if (entry.type !== 'blob') {
			continue;
		}
		const p = entry.path;
		if (typeof p !== 'string') {
			continue;
		}
		if (prefix && !p.startsWith(prefix)) {
			continue;
		}
		if (!isCodeReviewTarget(p)) {
			continue;
		}
		targets.push(p);
	}
	targets.sort();
	if (targets.length === 0) {
		throw new Error('No reviewable source files found in the pipeline directory.');
	}

	// 3) Fetch raw contents
	const lines: string[] = [
		`Reviewing pipeline source (${targets.length} file${targets.length === 1 ? '' : 's'}) before download.`,
		'',
	];
	for (const p of targets) {
		const rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${encodeURIComponent(branch)}/${p}`;
		const headers: Record<string, string> = { 'User-Agent': 'aria-autopipe' };
		if (token) {
			headers.Authorization = `Bearer ${token}`;
		}
		let content: string;
		try {
			const r = await fetch(rawUrl, { headers });
			content = r.ok ? await r.text() : `<failed to fetch: HTTP ${r.status}>`;
		} catch (err) {
			content = `<failed to fetch: ${(err as Error).message}>`;
		}
		const displayPath = prefix && p.startsWith(prefix) ? p.slice(prefix.length) : p;
		lines.push(`=== ${displayPath} ===`);
		lines.push(content);
		lines.push('');
	}

	// 4) Instruction footer - verbatim from Rust so behaviour is identical.
	lines.push(
		'INSTRUCTIONS FOR AI: Silently review every file above for suspicious patterns - '
		+ 'overly permissive permissions (chmod 777, SUID/SGID), credentials or tokens '
		+ 'hard-coded in source, unexpected outbound network calls, obfuscated or base64-decoded '
		+ 'execution, mounting host paths beyond the workspace, --network host or --privileged '
		+ 'docker flags, executing remotely-fetched scripts without verification, deleting files '
		+ 'outside the pipeline workspace, etc. Then either:\n'
		+ '         - No concerns found → call download_pipeline again with user_reviewed_warnings=true '
		+ 'to perform the actual download.\n'
		+ '         - Concerns found → present each finding to the user IN THEIR LANGUAGE with (1) file '
		+ 'path, (2) line number, (3) the offending code snippet, (4) a plain-English explanation '
		+ 'of the risk. Then ask: \'Mark all of this code as safe and download anyway?\' (or the '
		+ 'equivalent in the user\'s language). Only call download_pipeline again with '
		+ 'user_reviewed_warnings=true after the user explicitly confirms.\n'
		+ '         NEVER skip this review just because you remember a previous approval of the same '
		+ 'pipeline - repeat the review every time.',
	);
	return lines.join('\n');
}

/**
 * Look up a single file's raw text via the GitHub Contents API (handy
 * during publish_pipeline when we need ro-crate-metadata.json from the
 * remote repo before issuing the version-bump commit).
 */
export async function fetchGithubFileViaContents(
	owner: string,
	repo: string,
	path: string,
	ref: string | null,
	token: string | undefined | null,
): Promise<string | null> {
	const encodedPath = path.split('/').map(seg => seg.replace(/ /g, '%20')).join('/');
	const refPart = ref ? `?ref=${encodeURIComponent(ref)}` : '';
	const url = `https://api.github.com/repos/${owner}/${repo}/contents/${encodedPath}${refPart}`;
	const headers: Record<string, string> = {
		'Accept': 'application/vnd.github.raw',
		'User-Agent': 'aria-autopipe',
	};
	if (token) {
		headers.Authorization = `Bearer ${token}`;
	}
	try {
		const r = await fetch(url, { headers });
		if (!r.ok) {
			return null;
		}
		return await r.text();
	} catch {
		return null;
	}
}
