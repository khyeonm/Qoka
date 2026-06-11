/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { parseGithubUrl } from './skillsManager';

/**
 * Fetch a skill's SKILL.md text directly from GitHub via the raw
 * content endpoint. We use this to analyze the skill BEFORE cloning
 * it, so the wizard can show the user what env vars / dependencies are
 * about to be touched before we put anything on disk.
 *
 * Branch resolution: when the URL doesn't specify a branch, we try
 * `main` first, then `master`. Most modern repos use `main`, but the
 * fallback covers older repos still on `master`.
 */

export interface FetchedSkillMd {
	content: string;
	/** The branch we actually used (matters when the URL didn't specify). */
	branch: string;
	/** The sub-path inside the repo where the SKILL.md was found. */
	subPath: string;
}

export async function fetchSkillMd(url: string): Promise<FetchedSkillMd> {
	const parsed = parseGithubUrl(url);
	if (!parsed) {
		throw new Error(`Not a valid GitHub URL: ${url}`);
	}
	const branches = parsed.branch ? [parsed.branch] : ['main', 'master'];
	const subPath = parsed.subPath ? parsed.subPath.replace(/^\/+|\/+$/g, '') + '/' : '';

	let lastErr: string | undefined;
	for (const branch of branches) {
		const rawUrl = `https://raw.githubusercontent.com/${parsed.owner}/${parsed.repo}/${branch}/${subPath}SKILL.md`;
		try {
			const res = await fetch(rawUrl);
			if (res.ok) {
				return {
					content: await res.text(),
					branch,
					subPath: subPath.replace(/\/$/, ''),
				};
			}
			lastErr = `HTTP ${res.status} at ${rawUrl}`;
		} catch (e) {
			lastErr = `Fetch failed for ${rawUrl}: ${(e as Error).message}`;
		}
	}
	throw new Error(
		`Could not download SKILL.md from ${url}. Tried branches: ${branches.join(', ')}. ${lastErr ?? ''}`,
	);
}

/**
 * Inspect a GitHub repository for ALL SKILL.md files it contains.
 * Used when the URL the user pasted didn't point at a single skill
 * (no SKILL.md at the given path) but the repo turns out to be a
 * multi-skill monorepo like google-deepmind/science-skills.
 *
 * Implemented via the Git Trees API (one call, recursive) so we don't
 * fan out a request per directory. Returns the list of sub-paths that
 * contain a SKILL.md, plus the branch we resolved them on.
 */
export interface DiscoveredSkills {
	owner: string;
	repo: string;
	branch: string;
	/** Sub-paths inside the repo, each a directory holding SKILL.md. */
	skillSubPaths: string[];
}

export async function discoverSkillsInRepo(url: string): Promise<DiscoveredSkills> {
	const parsed = parseGithubUrl(url);
	if (!parsed) {
		throw new Error(`Not a valid GitHub URL: ${url}`);
	}
	const candidateBranches = parsed.branch ? [parsed.branch] : ['main', 'master'];

	let lastErr: string | undefined;
	for (const branch of candidateBranches) {
		const apiUrl = `https://api.github.com/repos/${parsed.owner}/${parsed.repo}/git/trees/${branch}?recursive=1`;
		try {
			const res = await fetch(apiUrl, {
				headers: { 'Accept': 'application/vnd.github+json' },
			});
			if (!res.ok) {
				lastErr = `HTTP ${res.status} at ${apiUrl}`;
				continue;
			}
			const json = await res.json() as { tree?: Array<{ path: string; type: string }>; truncated?: boolean };
			const tree = json.tree ?? [];
			const skillPaths: string[] = [];
			for (const entry of tree) {
				if (entry.type !== 'blob') {
					continue;
				}
				if (!/(^|\/)SKILL\.md$/.test(entry.path)) {
					continue;
				}
				const dir = entry.path.replace(/\/?SKILL\.md$/, '');
				if (dir.length === 0) {
					skillPaths.push('');
				} else {
					skillPaths.push(dir);
				}
			}
			if (json.truncated) {
				// Best-effort: trees API truncates after 100k entries. The
				// caller can still show the partial list — large monorepos
				// are rare for skills today.
			}
			// If the user pasted a subpath, only surface SKILL.md files
			// under that subpath; the others belong to unrelated parts of
			// the repo.
			const subPath = parsed.subPath?.replace(/^\/+|\/+$/g, '') ?? '';
			const filtered = subPath
				? skillPaths.filter(p => p === subPath || p.startsWith(subPath + '/'))
				: skillPaths;
			return {
				owner: parsed.owner,
				repo: parsed.repo,
				branch,
				skillSubPaths: filtered.sort(),
			};
		} catch (e) {
			lastErr = `Discovery failed for ${apiUrl}: ${(e as Error).message}`;
		}
	}
	throw new Error(
		`Could not list SKILL.md files in ${url}. Tried branches: ${candidateBranches.join(', ')}. ${lastErr ?? ''}`,
	);
}

/**
 * Fetch SKILL.md at a specific (owner, repo, branch, subPath). Lower
 * level than fetchSkillMd — used after the user picks a sub-path from
 * a multi-skill repo so we can analyze it before cloning.
 */
export async function fetchSkillMdAtPath(
	owner: string,
	repo: string,
	branch: string,
	subPath: string,
): Promise<FetchedSkillMd> {
	const normalized = subPath.replace(/^\/+|\/+$/g, '');
	const pathPart = normalized.length > 0 ? `${normalized}/` : '';
	const rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${pathPart}SKILL.md`;
	const res = await fetch(rawUrl);
	if (!res.ok) {
		throw new Error(`Could not download SKILL.md at ${rawUrl} (HTTP ${res.status}).`);
	}
	return {
		content: await res.text(),
		branch,
		subPath: normalized,
	};
}
