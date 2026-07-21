/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as https from 'https';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';
import { SkillInfo } from './types';
import { DEFAULT_SKILLS } from './defaultSkills';
import {
	findSkill,
	readManifest,
	removeSkill as removeSkillFromManifest,
	updateSkill,
	upsertSkill,
} from './skillManifest';
import { parseSkillMd } from './parseSkillMd';
import { writeEnv } from './envManager';

// Prefer execFile (argv array, no shell) for anything with file PATHS: it needs
// no quoting, so paths with spaces (e.g. `C:\Users\kyung min\...`) work on
// Windows cmd.exe too - plain `exec` with our Unix-style single quotes broke
// there ("Too many arguments" / "Failed to open ''...''").
const execFileAsync = promisify(execFile);

/**
 * Manages the on-disk skill directories under ~/.claude/skills/. Qoka's
 * manifest stays in sync via skillManifest.ts - the two together are the
 * single source of truth for "which skills does Qoka know about".
 *
 * Skill install is currently git-clone-only. Future sources (local path,
 * tarball, registry) can be added by branching at `install()`.
 */

const SKILLS_DIR = path.join(os.homedir(), '.claude', 'skills');

/** Parsed pieces of a GitHub URL - what we need to drive git operations. */
interface GithubLocation {
	owner: string;
	repo: string;
	/** Branch / tag, defaults to the repo's default branch when omitted. */
	branch?: string;
	/** Sub-directory inside the repo where the skill lives. */
	subPath?: string;
}

/**
 * Parse the kinds of GitHub URLs users paste when adding a skill:
 *   https://github.com/owner/repo
 *   https://github.com/owner/repo/tree/branch/path/to/skill
 * Returns null when the URL isn't a recognisable github.com URL.
 */
export function parseGithubUrl(url: string): GithubLocation | null {
	const trimmed = url.trim().replace(/\/+$/, '');
	const stripped = trimmed.startsWith('https://github.com/')
		? trimmed.slice('https://github.com/'.length)
		: trimmed.startsWith('http://github.com/')
			? trimmed.slice('http://github.com/'.length)
			: null;
	if (stripped === null) {
		return null;
	}
	const parts = stripped.split('/');
	if (parts.length < 2) {
		return null;
	}
	const owner = parts[0];
	const repo = parts[1];
	if (parts.length >= 4 && parts[2] === 'tree') {
		const branch = parts[3];
		const subPath = parts.slice(4).join('/');
		return { owner, repo, branch, subPath: subPath || undefined };
	}
	return { owner, repo };
}

/**
 * Derive the skill directory name from a GitHub URL - the last path
 * component, with no leading punctuation. Used as the on-disk folder name
 * under ~/.claude/skills/.
 */
export function deriveSkillName(url: string): string {
	const parsed = parseGithubUrl(url);
	if (!parsed) {
		return 'unknown-skill';
	}
	if (parsed.subPath) {
		const parts = parsed.subPath.split('/').filter(Boolean);
		return parts[parts.length - 1] || parsed.repo;
	}
	return parsed.repo;
}

/** Where Qoka expects ~/.claude/skills/ to live. Surfaces it for tooling. */
export function skillsRootDir(): string {
	return SKILLS_DIR;
}

/** Resolve the on-disk path for a given skill name. */
export function skillPath(name: string): string {
	return path.join(SKILLS_DIR, name);
}

/** True iff the skill's directory currently exists on disk. */
export function isInstalledOnDisk(name: string): boolean {
	return fs.existsSync(skillPath(name));
}

/** Make sure ~/.claude/skills/ exists so subsequent operations don't ENOENT. */
export function ensureSkillsDir(): void {
	fs.mkdirSync(SKILLS_DIR, { recursive: true });
}

/**
 * Clone a skill from GitHub into ~/.claude/skills/<name>/. When the URL
 * has no sub-path we clone the whole repo; when it has one we do a sparse
 * checkout so we don't pull megabytes of unrelated content.
 *
 * Throws on any failure - the caller is expected to surface a readable
 * error message to the user.
 */
export async function cloneFromGithub(
	url: string,
	targetName: string,
): Promise<string> {
	const parsed = parseGithubUrl(url);
	if (!parsed) {
		throw new Error(`Not a valid GitHub URL: ${url}`);
	}
	ensureSkillsDir();
	const dest = skillPath(targetName);
	const tmp = `${dest}.cloning`;
	// Wipe any leftover artifacts from a previous failed install in this
	// slot. Both the dest and the tmp folder can be left behind: the
	// dest when an older version exists, the tmp when a prior run died
	// after extracting but before deleting the scratch tree.
	hardRemove(dest);
	hardRemove(tmp);
	if (fs.existsSync(dest)) {
		throw new Error(`A skill named "${targetName}" already exists at ${dest} and could not be removed.`);
	}

	const repoUrl = `https://github.com/${parsed.owner}/${parsed.repo}.git`;
	const branch = parsed.branch;
	const subPath = parsed.subPath;

	// Prefer git (fast, sparse), but a non-developer machine - especially on
	// Windows - often has NO git on PATH, which is why default skills like
	// paper-lookup silently failed to install there. Fall back to a plain HTTPS
	// tarball download (needs no git, just the `tar` that ships with Windows 10+,
	// macOS and Linux) so skill install works everywhere.
	try {
		if (!subPath) {
			// Full clone - simplest path. depth=1 so the .git dir stays small.
			const branchArgs = branch ? ['--branch', branch] : [];
			await execFileAsync('git', ['clone', '--depth', '1', ...branchArgs, repoUrl, dest], { timeout: 60000 });
			return dest;
		}
		// Sparse checkout - clone with --no-checkout, set sparse cone to the
		// sub-path, then checkout. Saves bandwidth on large repos.
		const branchArgs = branch ? ['-b', branch] : [];
		try {
			await execFileAsync('git', ['clone', '--depth', '1', '--filter=blob:none', '--sparse', ...branchArgs, repoUrl, tmp], { timeout: 60000 });
			await execFileAsync('git', ['sparse-checkout', 'set', subPath], { cwd: tmp, timeout: 30000 });
			const sub = path.join(tmp, subPath);
			if (!fs.existsSync(sub)) {
				throw new Error(`Sub-path "${subPath}" not found in cloned repo.`);
			}
			// COPY (not rename) the checked-out tree into the final location.
			fs.cpSync(sub, dest, { recursive: true });
			return dest;
		} finally {
			hardRemove(tmp);
		}
	} catch (gitErr) {
		try {
			return await fetchGithubTarball(parsed, dest);
		} catch (tarErr) {
			throw new Error(`Could not install "${targetName}": git failed (${(gitErr as Error).message}) and the tarball fallback failed (${(tarErr as Error).message}).`);
		}
	}
}

/** Install a GitHub skill WITHOUT git: download the repo tarball over HTTPS and
 *  extract (optionally just the sub-path). Uses the `tar` that ships with
 *  Windows 10+/macOS/Linux, so a machine with no git still gets default skills. */
async function fetchGithubTarball(parsed: { owner: string; repo: string; branch?: string; subPath?: string }, dest: string): Promise<string> {
	const ref = parsed.branch || 'HEAD';
	const url = `https://codeload.github.com/${parsed.owner}/${parsed.repo}/tar.gz/${ref}`;
	const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aria-skill-'));
	const tgz = path.join(tmpRoot, 'skill.tar.gz');
	try {
		await httpsDownload(url, tgz);
		await execFileAsync('tar', ['-xzf', tgz, '-C', tmpRoot], { timeout: 60000 });
		// The archive's single top-level dir is `${repo}-<resolved-ref>`, whose
		// exact name we can't predict for HEAD - so pick the one extracted dir.
		const dirs = fs.readdirSync(tmpRoot, { withFileTypes: true }).filter(e => e.isDirectory());
		if (!dirs.length) {
			throw new Error('Downloaded tarball contained no directory.');
		}
		const top = path.join(tmpRoot, dirs[0].name);
		const src = parsed.subPath ? path.join(top, parsed.subPath) : top;
		if (!fs.existsSync(src)) {
			throw new Error(`Sub-path "${parsed.subPath ?? ''}" not found in the downloaded repo.`);
		}
		hardRemove(dest);
		fs.cpSync(src, dest, { recursive: true });
		return dest;
	} finally {
		hardRemove(tmpRoot);
	}
}

/** GET `url` to `dest`, following redirects (GitHub → codeload → S3). */
function httpsDownload(url: string, dest: string, redirects = 0): Promise<void> {
	return new Promise((resolve, reject) => {
		if (redirects > 5) { reject(new Error(`Too many redirects for ${url}`)); return; }
		https.get(url, { headers: { 'User-Agent': 'Qoka' } }, (res) => {
			if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
				res.resume();
				httpsDownload(res.headers.location, dest, redirects + 1).then(resolve, reject);
				return;
			}
			if (res.statusCode !== 200) {
				res.resume();
				reject(new Error(`Download failed (${res.statusCode}) for ${url}`));
				return;
			}
			const out = fs.createWriteStream(dest);
			res.pipe(out);
			out.on('finish', () => out.close(() => resolve()));
			out.on('error', (e) => reject(e));
		}).on('error', reject);
	});
}

/**
 * Force-remove a directory tree. Tries Node's recursive rmSync first,
 * then falls back to `rm -rf` via the shell when that fails - git's
 * pack objects are sometimes written read-only and rmSync chokes on
 * them with ENOTEMPTY (the recursive walker can't unlink the
 * read-only blob, so the parent directory stays non-empty).
 * `rm -rf` clears the read-only bit and walks the tree without
 * confusion.
 */
function hardRemove(target: string): void {
	if (!fs.existsSync(target)) {
		return;
	}
	try {
		fs.rmSync(target, { recursive: true, force: true });
		if (!fs.existsSync(target)) {
			return;
		}
	} catch {
		// fall through to shell rm
	}
	try {
		require('child_process').execSync(`rm -rf ${quote(target)}`, { timeout: 15000 });
	} catch {
		// Last resort: leave it on disk. Subsequent runs will retry the
		// cleanup; surfacing this as a hard error here would block the
		// install when the actual skill already landed in `dest`.
	}
}

/**
 * Remove a skill from disk AND from the manifest. Idempotent.
 *
 * Also prunes ~/.env: any env var the uninstalled skill declared that
 * isn't referenced by another installed skill is removed from the file.
 * Vars still claimed by another skill stay, so uninstalling one skill
 * doesn't break a sibling that happens to share, say, NCBI_API_KEY.
 *
 * Order matters: we snapshot the leaving skill's vars BEFORE removing
 * it from the manifest, then read the manifest AFTER removal to figure
 * out which vars are still in use.
 */
/**
 * Install a skill by copying an app-bundled directory into
 * ~/.claude/skills/<name>/. Used for default skills that ship WITH Qoka (e.g.
 * iterative-paper-defense) instead of being cloned from GitHub - no network.
 */
/**
 * Resolve an app-bundled skill path (relative to the aria-skills extension root,
 * e.g. 'skills/iterative-paper-defense') to an absolute path - robust to how the
 * extension was compiled (tsc keeps out/<subdir>/, so __dirname isn't the root).
 */
export function resolveBundledPath(rel: string): string {
	const ext = vscode.extensions.getExtension('aria.aria-skills');
	const root = ext?.extensionUri?.fsPath ?? path.join(__dirname, '..', '..');
	return path.join(root, rel);
}

export function installFromLocal(srcDir: string, targetName: string): string {
	if (!fs.existsSync(path.join(srcDir, 'SKILL.md'))) {
		throw new Error(`No SKILL.md at bundled path ${srcDir}.`);
	}
	ensureSkillsDir();
	const dest = skillPath(targetName);
	hardRemove(dest);
	fs.cpSync(srcDir, dest, { recursive: true });
	return dest;
}

/**
 * Non-Claude AI providers scan their OWN skills directory. Qoka installs the
 * canonical copy under ~/.claude/skills/ and mirrors each skill into every
 * installed provider's dir so Codex discovers the same skills. The
 * SKILL.md payload is provider-neutral; only the scan path differs.
 */
const PROVIDER_SKILL_ROOTS: { extId: string; dir: string }[] = [
	{ extId: 'openai.chatgpt', dir: path.join(os.homedir(), '.codex', 'skills') },
];

function installedProviderSkillDirs(): string[] {
	return PROVIDER_SKILL_ROOTS
		.filter(p => !!vscode.extensions.getExtension(p.extId))
		.map(p => p.dir);
}

/** Mirror an installed skill (~/.claude/skills/<name>) into every installed
 *  non-Claude provider's skills dir. Best-effort per provider. */
export function mirrorSkillToProviders(name: string): void {
	const src = skillPath(name);
	if (!fs.existsSync(src)) {
		return;
	}
	for (const dir of installedProviderSkillDirs()) {
		const dest = path.join(dir, name);
		try {
			fs.mkdirSync(dir, { recursive: true });
			hardRemove(dest);
			fs.cpSync(src, dest, { recursive: true });
		} catch (e) {
			console.warn(`[aria-skills] mirror skill "${name}" -> ${dir} failed: ${(e as Error).message}`);
		}
	}
}

/** Remove a skill from every provider's skills dir (Claude handled separately). */
export function removeSkillFromProviders(name: string): void {
	for (const { dir } of PROVIDER_SKILL_ROOTS) {
		hardRemove(path.join(dir, name));
	}
}

/**
 * Keep app-bundled default skills fresh. `installFromLocal` only runs on first
 * install, so an edit to a bundled skill (e.g. iterative-paper-defense gaining
 * Codex support) would never reach an already-set-up profile. On each launch,
 * re-copy any bundled default skill whose SKILL.md differs from the installed
 * copy, and re-mirror it to the provider dirs. Skips skills not installed yet
 * (the first-run wizard handles those). Best-effort per skill.
 */
/** Compare two env-var REQUIREMENT lists (order-insensitive, by name/required/
 *  description/obtainUrl). Used to decide whether an installed skill's manifest
 *  needs its env-var requirements refreshed from the curated defaults. */
function envVarsChanged(
	a: { name: string; required?: boolean; description?: string; obtainUrl?: string }[],
	b: { name: string; required?: boolean; description?: string; obtainUrl?: string }[],
): boolean {
	const norm = (arr: typeof a): string =>
		JSON.stringify([...arr]
			.sort((x, y) => x.name.localeCompare(y.name))
			.map(v => ({ name: v.name, required: !!v.required, description: v.description ?? '', obtainUrl: v.obtainUrl ?? '' })));
	return norm(a) !== norm(b);
}

export function resyncBundledSkills(): void {
	for (const spec of DEFAULT_SKILLS) {
		if (!spec.bundledPath) {
			continue;
		}
		try {
			const srcDir = resolveBundledPath(spec.bundledPath);
			const srcMd = path.join(srcDir, 'SKILL.md');
			const destMd = path.join(skillPath(spec.name), 'SKILL.md');
			// Not installed yet.
			if (!fs.existsSync(srcMd) || !fs.existsSync(destMd)) {
				// Hidden internal skills (e.g. the using-qoka tool-routing guide) never
				// appear in the first-run wizard and carry no keys, so install them
				// silently HERE - otherwise EXISTING profiles (already past first-run)
				// would never receive them. Fresh installs still get them via the wizard.
				if (spec.hidden && fs.existsSync(srcMd) && !fs.existsSync(destMd)) {
					const dest = installFromLocal(srcDir, spec.name);
					recordSkill({
						name: spec.name,
						category: spec.category,
						description: spec.description,
						source: `bundled:${spec.bundledPath}`,
						type: 'default',
						installedAt: new Date().toISOString(),
						envVars: spec.envVars ?? [],
						dependencies: [],
						autoApprove: false,
						path: dest,
						hidden: true,
					});
				}
				continue;
			}
			if (fs.readFileSync(srcMd, 'utf8') !== fs.readFileSync(destMd, 'utf8')) {
				installFromLocal(srcDir, spec.name);
				mirrorSkillToProviders(spec.name);
			}
			// Keep the installed manifest's env-var REQUIREMENTS in sync with the
			// curated spec.envVars. A skill installed before the curated keys existed
			// (or via SKILL.md analysis) can carry fewer/older entries - e.g.
			// paper-lookup showing 2 keys instead of 4 - so refresh them here. Only
			// the requirement metadata changes; the user's actual VALUES live in
			// ~/.env and are untouched.
			if (spec.envVars) {
				const installed = listManaged().find(s => s.name === spec.name);
				if (installed && envVarsChanged(installed.envVars ?? [], spec.envVars)) {
					updateSkill(spec.name, { envVars: spec.envVars });
				}
			}
		} catch {
			// best-effort - a stale copy is harmless; the skill still works.
		}
	}
}

/** Mirror ALL managed skills into every installed provider dir. Call when a
 *  provider is installed after startup so pre-existing skills show up there. */
export function syncSkillsToProviders(): void {
	if (installedProviderSkillDirs().length === 0) {
		return;
	}
	for (const skill of listManaged()) {
		mirrorSkillToProviders(skill.name);
	}
}

export async function uninstall(name: string): Promise<void> {
	const leaving = findSkill(name);
	const leavingVars = leaving?.envVars?.map(v => v.name) ?? [];

	const dir = skillPath(name);
	hardRemove(dir);
	removeSkillFromProviders(name);
	removeSkillFromManifest(name);

	if (leavingVars.length === 0) {
		return;
	}

	const remainingVars = new Set<string>();
	for (const skill of readManifest().skills) {
		for (const v of skill.envVars ?? []) {
			remainingVars.add(v.name);
		}
	}
	const orphaned = leavingVars.filter(v => !remainingVars.has(v));
	if (orphaned.length === 0) {
		return;
	}

	try {
		// writeEnv's removeKeys param already handles the "drop the
		// line entirely, preserve the rest" case - see envManager.ts.
		writeEnv({}, orphaned);
	} catch (err) {
		// Best-effort: if we can't write the env file, the manifest is
		// already updated and the skill is gone. Surface the failure
		// in the log so the user can clean up manually if they care.
		console.error(`[aria-skills] failed to prune ~/.env after uninstalling ${name}: ${(err as Error).message}`);
	}
}

/** Re-clone a skill by uninstalling + reinstalling. Used by Update flow. */
export async function reinstall(
	name: string,
	source: string,
): Promise<string> {
	await uninstall(name);
	const existing = findSkill(name);
	// App-bundled skills (source "bundled:<relPath>") re-copy from the bundle,
	// never GitHub - they update with the app, not over the network.
	if (source.startsWith('bundled:')) {
		const rel = source.slice('bundled:'.length);
		return installFromLocal(resolveBundledPath(rel), existing?.name ?? name);
	}
	const targetName = existing?.name ?? deriveSkillName(source);
	return cloneFromGithub(source, targetName);
}

/**
 * List the skills currently recorded in the manifest. Note this does NOT
 * scan the disk - the manifest is the source of truth. Use
 * `reconcileWithDisk()` to repair drift if a user deletes a skill
 * directory by hand.
 */
export function listManaged(): SkillInfo[] {
	return readManifest().skills;
}

/**
 * One-shot repair of env-var descriptions cached by OLDER builds: a skill that
 * documents its variables in a markdown TABLE ended up with garbled `| cell |`
 * / `---|---` fragments as the "description" (the regex fallback ran before a CLI
 * could produce a clean summary, and the result was cached in the manifest).
 * Re-parse with the current, table-aware parser and replace ONLY the garbage
 * descriptions - genuine prose / LLM-generated ones are left untouched. Fast,
 * offline, best-effort. Runs on startup.
 */
export function cleanupEnvDescriptions(): void {
	const isGarbage = (d?: string): boolean => !!d && (/\|/.test(d) || /-{3,}/.test(d));
	for (const skill of listManaged()) {
		try {
			if (!skill.envVars?.some(v => isGarbage(v.description))) {
				continue;
			}
			const md = readSkillMd(skill.name);
			if (!md) {
				continue;
			}
			const fresh = new Map(parseSkillMd(md).envVars.map(v => [v.name, v.description]));
			const envVars = skill.envVars.map(v =>
				isGarbage(v.description) ? { ...v, description: fresh.get(v.name) } : v);
			updateSkill(skill.name, { envVars });
		} catch {
			// best-effort per skill - a stale description is harmless.
		}
	}
}

/**
 * Drop manifest entries whose on-disk directory disappeared (e.g. the
 * user `rm -rf`'d ~/.claude/skills/foo). Doesn't add entries for skills
 * that exist on disk but aren't in the manifest - those were likely
 * installed by another tool and Qoka shouldn't claim them.
 */
/** Every skill directory the Skills tab should reflect: Qoka's canonical
 *  ~/.claude/skills/ PLUS each provider's dir (~/.codex/skills/) that exists on
 *  disk. A skill counts as present if its folder is in ANY of them. */
function allSkillScanDirs(): string[] {
	return [SKILLS_DIR, ...PROVIDER_SKILL_ROOTS.map(p => p.dir)]
		.filter(d => { try { return fs.existsSync(d); } catch { return false; } });
}

/** True when a skill folder exists in ANY provider dir (not just ~/.claude). */
function isInstalledOnAnyDisk(name: string): boolean {
	return allSkillScanDirs().some(d => {
		try { return fs.existsSync(path.join(d, name)); } catch { return false; }
	});
}

/** Build a display-only SkillInfo for a skill folder found on disk but NOT in the
 *  manifest - e.g. added directly to ~/.codex/skills/ outside Qoka. Metadata is
 *  read from its SKILL.md. Not persisted or mirrored; purely so the Skills tab
 *  reflects skills present in either provider's dir. */
function adoptDiskSkill(name: string, dir: string): SkillInfo {
	let description: string | undefined;
	let category: string | undefined;
	let envVars: SkillInfo['envVars'] = [];
	try {
		const parsed = parseSkillMd(fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8'));
		description = parsed.description;
		category = parsed.category;
		envVars = parsed.envVars ?? [];
	} catch { /* missing/unreadable SKILL.md - use defaults */ }
	// Keep internal hidden defaults (e.g. the using-qoka router) hidden even when
	// adopted straight from disk, so they never leak into the Skills tab.
	const hidden = DEFAULT_SKILLS.find(d => d.name === name)?.hidden;
	return {
		name,
		category: category || 'Imported',
		description: description || 'Skill found on disk (added outside Qoka).',
		source: dir,
		type: 'user',
		installedAt: new Date().toISOString(),
		envVars,
		dependencies: [],
		autoApprove: false,
		path: dir,
		hidden,
	};
}

export function reconcileWithDisk(): SkillInfo[] {
	// Drop manifest entries whose folder is gone from EVERY provider dir.
	for (const skill of listManaged()) {
		if (!isInstalledOnAnyDisk(skill.name)) {
			removeSkillFromManifest(skill.name);
		}
	}
	const kept = listManaged();
	const known = new Set(kept.map(s => s.name));
	// Adopt disk-only folders across ~/.claude/skills/ + provider dirs, deduped by
	// name so a skill present in BOTH is shown once. Lets a Codex-only user (or a
	// skill added straight into ~/.codex/skills/) still appear in the Skills tab.
	const adopted: SkillInfo[] = [];
	for (const dir of allSkillScanDirs()) {
		let names: string[] = [];
		try {
			names = fs.readdirSync(dir, { withFileTypes: true })
				.filter(e => e.isDirectory())
				.map(e => e.name);
		} catch { /* ignore unreadable dir */ }
		for (const name of names) {
			if (known.has(name)) { continue; }
			known.add(name);
			adopted.push(adoptDiskSkill(name, path.join(dir, name)));
		}
	}
	return [...kept, ...adopted];
}

/** Add or replace a skill record in the manifest. Convenience re-export. */
export function recordSkill(skill: SkillInfo): SkillInfo {
	upsertSkill(skill);
	// Mirror into any installed non-Claude provider's skills dir so Codex
	// discovers it too (Claude reads ~/.claude/skills/ directly).
	mirrorSkillToProviders(skill.name);
	return skill;
}

/**
 * Read a skill's SKILL.md content from disk. Returns null when the file
 * is missing - happens when the skill was cloned successfully but the
 * upstream repo doesn't follow the SKILL.md convention.
 */
export function readSkillMd(name: string): string | null {
	const candidate = path.join(skillPath(name), 'SKILL.md');
	if (!fs.existsSync(candidate)) {
		return null;
	}
	return fs.readFileSync(candidate, 'utf8');
}

/** Shell-quote a string the safe way (single quotes + escape '). */
function quote(s: string): string {
	if (/^[A-Za-z0-9_./:@-]+$/.test(s)) {
		return s;
	}
	return `'${s.replace(/'/g, "'\\''")}'`;
}
