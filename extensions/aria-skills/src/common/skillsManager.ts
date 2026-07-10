/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { exec } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';
import { SkillInfo } from './types';
import {
	findSkill,
	readManifest,
	removeSkill as removeSkillFromManifest,
	upsertSkill,
} from './skillManifest';
import { writeEnv } from './envManager';

const execAsync = promisify(exec);

/**
 * Manages the on-disk skill directories under ~/.claude/skills/. Aria's
 * manifest stays in sync via skillManifest.ts — the two together are the
 * single source of truth for "which skills does Aria know about".
 *
 * Skill install is currently git-clone-only. Future sources (local path,
 * tarball, registry) can be added by branching at `install()`.
 */

const SKILLS_DIR = path.join(os.homedir(), '.claude', 'skills');

/** Parsed pieces of a GitHub URL — what we need to drive git operations. */
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
 * Derive the skill directory name from a GitHub URL — the last path
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

/** Where Aria expects ~/.claude/skills/ to live. Surfaces it for tooling. */
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
 * Throws on any failure — the caller is expected to surface a readable
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

	if (!subPath) {
		// Full clone — simplest path. depth=1 so the .git dir stays small.
		const branchArg = branch ? `--branch ${quote(branch)} ` : '';
		const cmd = `git clone --depth 1 ${branchArg}${quote(repoUrl)} ${quote(dest)}`;
		await execAsync(cmd, { timeout: 60000 });
		return dest;
	}

	// Sparse checkout — clone with --no-checkout, set sparse cone to the
	// sub-path, then checkout. Saves bandwidth on large repos.
	const branchArg = branch ? `-b ${quote(branch)} ` : '';
	const stepClone = `git clone --depth 1 --filter=blob:none --sparse ${branchArg}${quote(repoUrl)} ${quote(tmp)}`;
	const stepSparse = `cd ${quote(tmp)} && git sparse-checkout set ${quote(subPath)}`;
	try {
		await execAsync(stepClone, { timeout: 60000 });
		await execAsync(stepSparse, { timeout: 30000 });
		const sub = path.join(tmp, subPath);
		if (!fs.existsSync(sub)) {
			throw new Error(`Sub-path "${subPath}" not found in cloned repo.`);
		}
		// COPY (not rename) the checked-out tree into the final location.
		// Rename would conflict with anything left at `dest`, and a copy
		// also crosses filesystem boundaries cleanly. Then nuke the tmp
		// tree with shell rm so git pack objects (which can be readonly)
		// and other quirks don't trip Node's fs.rmSync.
		fs.cpSync(sub, dest, { recursive: true });
		hardRemove(tmp);
		return dest;
	} catch (err) {
		hardRemove(tmp);
		throw err;
	}
}

/**
 * Force-remove a directory tree. Tries Node's recursive rmSync first,
 * then falls back to `rm -rf` via the shell when that fails — git's
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
 * ~/.claude/skills/<name>/. Used for default skills that ship WITH Aria (e.g.
 * iterative-paper-defense) instead of being cloned from GitHub — no network.
 */
/**
 * Resolve an app-bundled skill path (relative to the aria-skills extension root,
 * e.g. 'skills/iterative-paper-defense') to an absolute path — robust to how the
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
 * Non-Claude AI providers scan their OWN skills directory. Aria installs the
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
		// line entirely, preserve the rest" case — see envManager.ts.
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
	// never GitHub — they update with the app, not over the network.
	if (source.startsWith('bundled:')) {
		const rel = source.slice('bundled:'.length);
		return installFromLocal(resolveBundledPath(rel), existing?.name ?? name);
	}
	const targetName = existing?.name ?? deriveSkillName(source);
	return cloneFromGithub(source, targetName);
}

/**
 * List the skills currently recorded in the manifest. Note this does NOT
 * scan the disk — the manifest is the source of truth. Use
 * `reconcileWithDisk()` to repair drift if a user deletes a skill
 * directory by hand.
 */
export function listManaged(): SkillInfo[] {
	return readManifest().skills;
}

/**
 * Drop manifest entries whose on-disk directory disappeared (e.g. the
 * user `rm -rf`'d ~/.claude/skills/foo). Doesn't add entries for skills
 * that exist on disk but aren't in the manifest — those were likely
 * installed by another tool and Aria shouldn't claim them.
 */
export function reconcileWithDisk(): SkillInfo[] {
	const managed = listManaged();
	const orphaned: string[] = [];
	for (const skill of managed) {
		if (!isInstalledOnDisk(skill.name)) {
			orphaned.push(skill.name);
		}
	}
	for (const name of orphaned) {
		removeSkillFromManifest(name);
	}
	return listManaged();
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
 * is missing — happens when the skill was cloned successfully but the
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
