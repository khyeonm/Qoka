/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { SshProfile, workspacePathsFor } from './types';
import { resolveOutputDir } from './dockerEnv';
import { shellEscape } from './roCrate';
import { services } from './services';

/**
 * Durably save autopipe pipeline CODE and selected RESULTS from the run target
 * (built-in VM or a remote SSH host) into the user's open VS Code workspace
 * folder. The built-in VM is a scratch environment - its disk lives in the
 * extension's global storage and can be wiped on base-image updates - so the
 * project folder is the only durable home for a user's pipelines and results.
 *
 * Everything here degrades gracefully: no workspace folder open, no active
 * profile, or an SSH error all resolve to a clear returned message rather than
 * throwing. File copies decode straight to disk (see SshService.downloadFilesBase64)
 * so large genomic outputs never buffer in memory.
 *
 * Unified project layout (data / analysis / results):
 *   <workspaceFolder>/analysis/<pipeline_name>/   pipeline code (working copy, by pipeline name)
 *   <workspaceFolder>/analysis/<run_name>/        run_code scripts (by run name)
 *   <workspaceFolder>/results/<run_name>/         saved result files (run_code + autopipe)
 *   <workspaceFolder>/data/<run_name>/manifest.json   input manifest (no bytes)
 *   <workspaceFolder>/data/<run_name>/            local input links (hardlink/junction)
 */

const LOG_PREFIX = '[aria-autopipe] workspaceSync';

export interface LocalAutopipePaths {
	/** The open workspace folder. */
	base: string;
	/** `<workspaceFolder>/analysis` - code (autopipe by pipeline name, run_code by run name). */
	analysis: string;
	/** `<workspaceFolder>/results` - outputs, per run name. */
	results: string;
	/** `<workspaceFolder>/data` - inputs + per-run manifests/links. */
	data: string;
}

/** First workspace folder's fsPath, or undefined when no folder is open. */
export function workspaceFolderPath(): string | undefined {
	return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

/**
 * Resolve the project's `data` / `analysis` / `results` dirs, or undefined when
 * no workspace folder is open. Does NOT create anything - call `ensureLocalDir`
 * at copy time so we never scaffold an empty tree.
 */
export function localAutopipePaths(): LocalAutopipePaths | undefined {
	const folder = workspaceFolderPath();
	if (!folder) {
		return undefined;
	}
	return {
		base: folder,
		analysis: path.join(folder, 'analysis'),
		results: path.join(folder, 'results'),
		data: path.join(folder, 'data'),
	};
}

/** `mkdir -p` for a local directory. */
export function ensureLocalDir(dir: string): void {
	fs.mkdirSync(dir, { recursive: true });
}

/**
 * Drop a `.qoka-pipeline.json` marker into the local `results/<run_name>/`
 * folder recording which pipeline produced it. The pipeline result viewer
 * reads this to offer a dedicated pipeline-type plugin for the whole folder
 * (see PluginService.findForPipeline). Best-effort: no workspace open, or a
 * write failure, is silently ignored - run_code results simply have no marker.
 */
export function writePipelineMarker(runName: string, pipelineName: string): void {
	const folder = workspaceFolderPath();
	if (!folder || !runName || !pipelineName) {
		return;
	}
	try {
		const dir = path.join(folder, 'results', runName);
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(
			path.join(dir, '.qoka-pipeline.json'),
			JSON.stringify({ pipeline: pipelineName, run_name: runName }, null, 2),
			'utf8',
		);
	} catch {
		/* best-effort */
	}
}

/** Local `analysis/` dir (run_code scripts), or undefined with no folder. */
export function localAnalysisDir(): string | undefined {
	const folder = workspaceFolderPath();
	return folder ? path.join(folder, 'analysis') : undefined;
}

/**
 * A run name that is free across ALL of the project dirs that key by run name
 * (analysis/, results/, data/), so a single name owns the matching folder in
 * each. Used by run_code so its script (analysis/<name>/), outputs
 * (results/<name>/) and input links (data/<name>/) share one collision-free name.
 */
export function uniqueRunName(base: string): string {
	const folder = workspaceFolderPath();
	const slug = (base || 'run').trim() || 'run';
	if (!folder) { return slug; }
	const dirs = [path.join(folder, 'analysis'), path.join(folder, 'results'), path.join(folder, 'data')];
	const taken = (name: string) => dirs.some(d => fs.existsSync(path.join(d, name)));
	if (!taken(slug)) { return slug; }
	for (let n = 2; n < 10000; n++) {
		const candidate = `${slug}-${n}`;
		if (!taken(candidate)) { return candidate; }
	}
	return slug;
}

export interface RunEnvResources {
	cpus: number | null;
	memTotalMB: number | null;
	memAvailMB: number | null;
	diskFreeGB: number | null;
	diskTotalGB: number | null;
}

/**
 * LIVE-detect the ACTIVE run environment's REAL resources by probing INSIDE it
 * (works for WSL, Mac vfkit and any SSH host - all go through ssh.run). Never
 * uses Qoka's config values, which are meaningless on WSL (it follows .wslconfig)
 * and stale elsewhere. Best-effort: a field is null when its probe failed. One
 * login runs all three probes: nproc, /proc/meminfo (kB), df (1K blocks) on the
 * filesystem that holds the run dir (repo_path).
 */
export async function detectRunEnvResources(profile: SshProfile): Promise<RunEnvResources> {
	const { ssh } = services();
	const repo = (profile.repo_path || '/').replace(/'/g, '');
	const cmd = [
		`printf 'CPUS %s\\n' "$(nproc 2>/dev/null || echo)"`,
		`awk '/^MemTotal:/{printf "MEMTOTAL %s\\n",$2} /^MemAvailable:/{printf "MEMAVAIL %s\\n",$2}' /proc/meminfo 2>/dev/null`,
		`df -Pk '${repo}' 2>/dev/null | awk 'NR==2{printf "DISK %s %s\\n",$2,$4}'`,
	].join('; ');
	const res: RunEnvResources = { cpus: null, memTotalMB: null, memAvailMB: null, diskFreeGB: null, diskTotalGB: null };
	try {
		const out = await ssh.run(profile, cmd, { timeoutMs: 15000 });
		for (const line of (out.stdout || '').split('\n')) {
			const cpu = line.match(/^CPUS\s+(\d+)/);
			if (cpu) { res.cpus = parseInt(cpu[1], 10); continue; }
			const mt = line.match(/^MEMTOTAL\s+(\d+)/);
			if (mt) { res.memTotalMB = Math.round(parseInt(mt[1], 10) / 1024); continue; }
			const ma = line.match(/^MEMAVAIL\s+(\d+)/);
			if (ma) { res.memAvailMB = Math.round(parseInt(ma[1], 10) / 1024); continue; }
			const dk = line.match(/^DISK\s+(\d+)\s+(\d+)/);
			if (dk) {
				res.diskTotalGB = Math.round((parseInt(dk[1], 10) / (1024 * 1024)) * 10) / 10;
				res.diskFreeGB = Math.round((parseInt(dk[2], 10) / (1024 * 1024)) * 10) / 10;
			}
		}
	} catch { /* probes failed - leave nulls */ }
	return res;
}

/** One-line, model-facing summary of live-detected run-env resources. Empty
 *  string when nothing could be read (so callers can omit the line). */
export function formatRunEnvResources(r: RunEnvResources): string {
	const parts: string[] = [];
	if (r.cpus !== null) { parts.push(`${r.cpus} CPU cores`); }
	if (r.memTotalMB !== null) {
		const avail = r.memAvailMB !== null ? `, ${(r.memAvailMB / 1024).toFixed(1)} GB free now` : '';
		parts.push(`${(r.memTotalMB / 1024).toFixed(1)} GB RAM${avail}`);
	}
	if (r.diskFreeGB !== null) { parts.push(`${r.diskFreeGB} GB disk free`); }
	return parts.join(', ');
}

/**
 * True when the run target's workspace lives on a host mount - WSL's Windows
 * mount (`/mnt/<drive>/…`) OR the Mac vfkit whole-host share (`/mnt/mac/…`, the
 * per-window project path) OR the legacy single-project share (`/mnt/qoka`) - i.e.
 * the guest writes straight to the user's local disk. In that "mounted" mode the
 * SFTP save/mirror steps are redundant (and would copy a file onto itself over
 * SFTP), so callers skip them.
 */
export function isMountedRepo(profile: SshProfile): boolean {
	return /^\/mnt\/([a-z]\/|qoka(\/|$)|mac(\/|$))/i.test(profile.repo_path);
}

/**
 * Create Qoka's local project scaffold on first launch:
 *   <workspaceFolder>/{data,analysis,results}/
 * so the mounted run environment has the dirs it writes into and the Analysis tab
 * shows them. Runs the one-time old-layout migration first. Idempotent, and never
 * removes anything: an existing folder is left exactly as it is. No-ops without an
 * open folder.
 *
 * These used to get a `.gitkeep` so the empty tree survived git. Dropped: the
 * moment a run writes a result the folder appears in git by itself, Qoka recreates
 * the tree whenever the project is opened, and the other template folders
 * (notes/, data/, …) never had one - so the files bought nothing and left the user
 * wondering what they were.
 */
export function ensureWorkspaceScaffold(root?: string): void {
	const folder = root ?? workspaceFolderPath();
	if (!folder) { return; }
	// Run the one-time migration from the old autopipe/ + mixed layout FIRST, then
	// make sure the three unified dirs exist.
	migrateProjectLayout(folder);
	const dirs = [
		path.join(folder, 'data'),
		path.join(folder, 'analysis'),
		path.join(folder, 'results'),
	];
	for (const d of dirs) {
		try {
			fs.mkdirSync(d, { recursive: true });
		} catch { /* best-effort */ }
	}
	// Auto-commit: seed the AI-instruction files so Claude Code (CLAUDE.md) and Codex
	// (AGENTS.md) commit meaningful work on their own, without the user running git.
	// Idempotent (marker-guarded) and never clobbers the user's own content.
	ensureAiCommitInstructions(folder);
	// Make sure .gitignore keeps data/ + results/ (and Qoka's working files) out of git
	// BEFORE any commit happens, so auto-commit versions only the real work.
	ensureProjectGitignore(folder);
}

/** Patterns kept out of git: Qoka's own working files, the generated data/ (large
 *  inputs) and results/ (regenerable outputs) trees, and the Qoka-generated AI
 *  instruction files (CLAUDE.md / AGENTS.md are regenerated per project open, so they
 *  are local tool config, not versioned content). Mirrors aria-vcs's list. */
const GITIGNORE_ENTRIES = ['.claude/', '.codex/', '.mcp.json', '.qoka/', 'node_modules/', '.DS_Store', 'data/', 'results/', 'CLAUDE.md', 'AGENTS.md', 'README.md'];

/** Ensure the project's `.gitignore` carries GITIGNORE_ENTRIES. Written here at project
 *  open (not only on the first snapshot) so the file is present before any commit - the
 *  AI's raw-git auto-commit, or aria-vcs snapshots. Idempotent per-line; best-effort. */
function ensureProjectGitignore(folder: string): void {
	try {
		const file = path.join(folder, '.gitignore');
		let existing = '';
		try { existing = fs.readFileSync(file, 'utf8'); } catch { /* none yet */ }
		const hasLine = (p: string) => existing.split(/\r?\n/).some(l => l.trim() === p);
		const missing = GITIGNORE_ENTRIES.filter(p => !hasLine(p));
		if (missing.length === 0) { return; }
		const sep = existing && !existing.endsWith('\n') ? '\n' : '';
		fs.writeFileSync(file, existing + sep + missing.join('\n') + '\n', 'utf8');
	} catch { /* best-effort */ }
}

const AUTO_COMMIT_MARKER = '<!-- qoka:auto-commit:start -->';

/** The raw-git auto-commit guidance injected into CLAUDE.md and AGENTS.md. Kept as a
 *  marker-delimited block so we can detect it and never duplicate it. */
const AUTO_COMMIT_BLOCK = [
	AUTO_COMMIT_MARKER,
	'## Auto-commit (Qoka)',
	'',
	'Keep the project history current WITHOUT the user having to run git.',
	'',
	'- The project is a git repo (Qoka sets it up). If `git status` reports it is NOT a repo',
	'  yet, run `git init` and set a local identity first, then continue.',
	'- After finishing a MEANINGFUL unit of work (a feature, a fix, a coherent change the',
	'  user asked for), commit it: `git add -A` then `git commit -m "<short imperative summary>"`.',
	'  (`data/` and `results/` are gitignored, so `git add -A` stages only your real work.)',
	'- One commit per meaningful, self-contained change. Do NOT commit after every tiny edit,',
	'  and do NOT lump unrelated changes into one commit.',
	'- git commands (add / status / commit / log / diff) are VERSION CONTROL, NOT analysis',
	'  code: run them DIRECTLY in your shell in the project directory. The "run code through',
	'  Qoka tools, not the terminal" rule is ONLY about running analysis / scripts, never git.',
	'- Do NOT `git push` and do not touch remotes - commits stay LOCAL.',
	'- Never commit secrets, credentials, or large data files (rely on .gitignore; never',
	'  force-add ignored paths). Never commit another person\'s changes.',
	'- If git reports a missing identity, set it LOCALLY only: `git config user.name "Qoka"`',
	'  and `git config user.email "user@localhost"` (never change the global git config).',
	'<!-- qoka:auto-commit:end -->',
	'',
].join('\n');

/** Ensure CLAUDE.md (Claude Code) and AGENTS.md (Codex) both carry the auto-commit block.
 *  Creates the file if absent; appends the block if the file exists without it; leaves it
 *  untouched once the marker is present. Best-effort - never throws. */
function ensureAiCommitInstructions(folder: string): void {
	for (const name of ['CLAUDE.md', 'AGENTS.md']) {
		try {
			const file = path.join(folder, name);
			if (fs.existsSync(file)) {
				const current = fs.readFileSync(file, 'utf8');
				if (current.includes(AUTO_COMMIT_MARKER)) { continue; }
				const sep = current.length === 0 || current.endsWith('\n') ? '\n' : '\n\n';
				fs.writeFileSync(file, current + sep + AUTO_COMMIT_BLOCK, 'utf8');
			} else {
				const header = `# Project instructions for AI assistants\n\n`;
				fs.writeFileSync(file, header + AUTO_COMMIT_BLOCK, 'utf8');
			}
		} catch { /* best-effort */ }
	}
}

/**
 * One-time migration from the old split layout to the unified data/analysis/results
 * tree. Idempotent and best-effort (never throws, never overwrites an existing
 * destination):
 *   autopipe/pipelines/<name>/            -> analysis/<name>/     (code, by pipeline name)
 *   autopipe/pipelines_output/<run>/      -> results/<run>/       (outputs, by run name)
 *   autopipe/pipelines_input/<n>.manifest.json -> data/<n>/manifest.json
 * The old run_code `analysis/<id>/` folders (code + outputs mixed) are LEFT in
 * place - they already live under analysis/ and cannot be split retroactively.
 * The emptied `autopipe/` dir is removed at the end.
 */
export function migrateProjectLayout(root?: string): void {
	const folder = root ?? workspaceFolderPath();
	if (!folder) { return; }
	const oldBase = path.join(folder, 'autopipe');
	if (!fs.existsSync(oldBase)) { return; }
	const moveChildren = (fromDir: string, toDir: string, transform?: (name: string) => string) => {
		if (!fs.existsSync(fromDir)) { return; }
		try {
			for (const entry of fs.readdirSync(fromDir, { withFileTypes: true })) {
				const from = path.join(fromDir, entry.name);
				const to = path.join(toDir, transform ? transform(entry.name) : entry.name);
				if (fs.existsSync(to)) { continue; } // never clobber an already-migrated dest
				try { ensureLocalDir(path.dirname(to)); fs.renameSync(from, to); }
				catch { /* leave it; best-effort */ }
			}
		} catch { /* best-effort */ }
	};
	try {
		moveChildren(path.join(oldBase, 'pipelines'), path.join(folder, 'analysis'));
		moveChildren(path.join(oldBase, 'pipelines_output'), path.join(folder, 'results'));
		// Input manifests: `<name>.manifest.json` -> `data/<name>/manifest.json`.
		const oldInput = path.join(oldBase, 'pipelines_input');
		if (fs.existsSync(oldInput)) {
			for (const entry of fs.readdirSync(oldInput, { withFileTypes: true })) {
				if (!entry.isFile() || !entry.name.endsWith('.manifest.json')) { continue; }
				const name = entry.name.replace(/\.manifest\.json$/, '');
				const to = path.join(folder, 'data', name, 'manifest.json');
				if (fs.existsSync(to)) { continue; }
				try { ensureLocalDir(path.dirname(to)); fs.renameSync(path.join(oldInput, entry.name), to); }
				catch { /* best-effort */ }
			}
		}
		// Remove the now-empty autopipe/ tree (rmSync no-ops if non-empty leftovers
		// remain - we only want to clear a fully-migrated tree).
		try { fs.rmSync(oldBase, { recursive: true, force: false }); }
		catch { /* something left behind - leave the dir for the user to inspect */ }
		console.log(`${LOG_PREFIX}: migrated old autopipe/ layout to data/analysis/results in ${folder}`);
	} catch (err) {
		console.warn(`${LOG_PREFIX}: layout migration skipped:`, (err as Error).message);
	}
}

/** Human-readable byte size, e.g. `1.4 GB`. */
export function humanSize(bytes: number): string {
	if (!Number.isFinite(bytes) || bytes < 0) {
		return `${bytes}`;
	}
	const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
	let value = bytes;
	let i = 0;
	while (value >= 1024 && i < units.length - 1) {
		value /= 1024;
		i++;
	}
	return i === 0 ? `${bytes} B` : `${value.toFixed(value >= 10 || value === Math.floor(value) ? 0 : 1)} ${units[i]}`;
}

export interface RemoteFileEntry {
	/** Absolute remote path. */
	path: string;
	sizeBytes: number;
}

/** Map an absolute remote path to a path relative to `baseDir` (POSIX '/'). */
function remoteRelative(baseDir: string, fullPath: string): string {
	const base = baseDir.replace(/\/+$/, '');
	if (fullPath === base) {
		return fullPath.slice(fullPath.lastIndexOf('/') + 1);
	}
	if (fullPath.startsWith(base + '/')) {
		return fullPath.slice(base.length + 1);
	}
	return fullPath.replace(/^\/+/, '');
}

/** Join a POSIX-relative path onto a local directory using the host separator. */
function localJoin(localDir: string, relPosix: string): string {
	return path.join(localDir, ...relPosix.split('/').filter(Boolean));
}

/**
 * List every regular file under `remoteDir` with its size, recursively.
 * Prefers GNU `find -printf` (present on the built-in VM and most Linux
 * hosts); falls back to `find ... -exec ls -ln` for BSD/macOS `find`, which
 * lacks `-printf`. Returns [] when the directory is missing or empty - never
 * throws. Intentionally cheap: sizes only, no hashing.
 */
export async function listRemoteFilesWithSizes(profile: SshProfile, remoteDir: string): Promise<RemoteFileEntry[]> {
	const { ssh } = services();
	const dir = remoteDir.replace(/\/+$/, '');

	// GNU find: one line per file as "<size>\t<abs-path>".
	try {
		const gnu = await ssh.run(profile, `find '${shellEscape(dir)}' -type f -printf '%s\\t%p\\n' 2>/dev/null`, { timeoutMs: 120000 });
		if (gnu.exitCode === 0 && gnu.stdout.trim()) {
			const parsed = parseSizeTabPath(gnu.stdout);
			if (parsed.length > 0) {
				return parsed;
			}
		}
	} catch (err) {
		console.warn(`${LOG_PREFIX}: GNU find failed for ${dir}:`, (err as Error).message);
	}

	// Fallback for BSD/macOS find (no -printf): parse `ls -ln` long listing.
	// Fields: perms links owner group SIZE month day time/year path...
	try {
		const bsd = await ssh.run(profile, `find '${shellEscape(dir)}' -type f -exec ls -ln {} + 2>/dev/null`, { timeoutMs: 120000 });
		if (bsd.exitCode === 0 && bsd.stdout.trim()) {
			return parseLsLong(bsd.stdout);
		}
	} catch (err) {
		console.warn(`${LOG_PREFIX}: ls fallback failed for ${dir}:`, (err as Error).message);
	}

	return [];
}

function parseSizeTabPath(stdout: string): RemoteFileEntry[] {
	const out: RemoteFileEntry[] = [];
	for (const line of stdout.split('\n')) {
		if (!line) { continue; }
		const tab = line.indexOf('\t');
		if (tab < 0) { continue; }
		const size = parseInt(line.slice(0, tab).trim(), 10);
		const p = line.slice(tab + 1).trim();
		if (!p || Number.isNaN(size)) { continue; }
		out.push({ path: p, sizeBytes: size });
	}
	return out;
}

function parseLsLong(stdout: string): RemoteFileEntry[] {
	const out: RemoteFileEntry[] = [];
	for (const line of stdout.split('\n')) {
		const l = line.trim();
		if (!l || l.startsWith('total ')) { continue; }
		// perms(1) links(2) owner(3) group(4) size(5) mon(6) day(7) time(8) path(9+)
		const parts = l.split(/\s+/);
		if (parts.length < 9) { continue; }
		const size = parseInt(parts[4], 10);
		if (Number.isNaN(size)) { continue; }
		const p = parts.slice(8).join(' ');
		if (!p) { continue; }
		out.push({ path: p, sizeBytes: size });
	}
	return out;
}

export interface CopySummary {
	ok: boolean;
	message: string;
	copied: number;
	failed: number;
	errors: string[];
	/** Files intentionally left on the server because they exceed `maxFileBytes`. */
	skipped: string[];
	/** Relative paths (POSIX) of the files actually written locally. Lets the
	 *  caller show them - opening a result beats reporting a folder name. */
	copiedFiles: string[];
	localDir?: string;
}

export interface CopyOptions {
	/** Do not download any single file larger than this; report it in `skipped`
	 *  instead. The caller is expected to ASK the user about those files rather
	 *  than either pulling a multi-GB genomic output unasked or dropping it
	 *  silently. */
	maxFileBytes?: number;
}

/**
 * Copy every file under `remoteDir` into `localDir`, preserving the relative
 * tree, over a SINGLE SSH login and WITHOUT SFTP (see downloadFilesBase64 for
 * why). Best-effort per file: one failure does not abort the rest, and the
 * summary reports both counts. Files above `maxFileBytes` are NOT copied - they
 * are returned in `skipped` so the caller can ask the user about them instead of
 * silently pulling a huge file or silently dropping it.
 */
async function copyRemoteDirInternal(profile: SshProfile, remoteDir: string, localDir: string, opts?: CopyOptions): Promise<CopySummary> {
	const { ssh } = services();
	const entries = await listRemoteFilesWithSizes(profile, remoteDir);
	ensureLocalDir(localDir);
	if (entries.length === 0) {
		return { ok: true, message: `No files found under ${remoteDir}.`, copied: 0, failed: 0, errors: [], skipped: [], copiedFiles: [], localDir };
	}
	const skipped: string[] = [];
	const limit = opts?.maxFileBytes;
	// Build the whole batch first: it is downloaded over a SINGLE SSH login.
	// One login per file used to trip servers that rate-limit rapid logins, so
	// the copy failed with an auth error even though the run had just succeeded.
	const batch: Array<{ remote: string; local: string; rel: string; expectedBytes: number }> = [];
	for (const entry of entries) {
		const rel = remoteRelative(remoteDir, entry.path);
		if (limit !== undefined && entry.sizeBytes > limit) {
			skipped.push(`${rel} (${humanSize(entry.sizeBytes)})`);
			continue;
		}
		batch.push({ remote: entry.path, local: localJoin(localDir, rel), rel, expectedBytes: entry.sizeBytes });
	}
	const byRemote = new Map(batch.map(b => [b.remote, b.rel]));
	let result: { copied: number; errors: Array<{ remote: string; message: string }> };
	try {
		result = await ssh.downloadFilesBase64(profile, batch.map(b => ({ remote: b.remote, local: b.local, expectedBytes: b.expectedBytes })));
	} catch (err) {
		// Log it: a copy that fails after a SUCCESSFUL run is confusing, and the
		// only clue used to be the tool's text result. Look in the Qoka DevTools
		// console (Help -> Toggle Developer Tools).
		console.error(`${LOG_PREFIX}: copy of ${remoteDir} failed:`, (err as Error).message);
		throw err;
	}
	const copied = result.copied;
	const failedRemotes = new Set(result.errors.map(e => e.remote));
	const copiedFiles = batch.filter(b => !failedRemotes.has(b.remote)).map(b => b.rel);
	const errors = result.errors.map(e => `${byRemote.get(e.remote) ?? e.remote}: ${e.message}`);
	if (errors.length) {
		console.warn(`${LOG_PREFIX}: ${errors.length} file(s) failed to copy from ${remoteDir}:`, errors.slice(0, 5));
	}
	return {
		ok: errors.length === 0,
		message: `Copied ${copied}/${batch.length} file(s) into ${localDir}.`
			+ (skipped.length ? ` Skipped ${skipped.length} file(s) over the size limit.` : ''),
		copied,
		failed: errors.length,
		errors,
		skipped,
		copiedFiles,
		localDir,
	};
}

/**
 * Public wrapper over the internal SFTP directory copy: stream every file under
 * an arbitrary `remoteDir` on the target into `localDir`, preserving the tree.
 * Used by qoka-run to pull a non-mounted built-in server's analysis outputs into
 * the project (the mounted WSL path needs no copy).
 */
export async function copyRemoteDirToLocal(profile: SshProfile, remoteDir: string, localDir: string, opts?: CopyOptions): Promise<CopySummary> {
	return copyRemoteDirInternal(profile, remoteDir, localDir, opts);
}

/** Strip autopipe-app's `autopipe-<name>` image prefix to recover the pipeline name. */
export function pipelineNameFromImage(imageName: string): string {
	return imageName.startsWith('autopipe-') ? imageName.slice('autopipe-'.length) : imageName;
}

export interface StepResult {
	ok: boolean;
	message: string;
}

/**
 * Copy pipeline CODE (`{pipelines_dir}/<name>`) from the target into
 * `<workspaceFolder>/analysis/<name>/` (by pipeline name - the working copy).
 * Code is small, so this is always safe to run without prompting. No-ops with a
 * clear message when there is no workspace folder. Never throws.
 */
export async function savePipelineCodeToProject(profile: SshProfile, pipelineName: string): Promise<StepResult> {
	try {
		const local = localAutopipePaths();
		if (!local) {
			return { ok: false, message: 'No workspace folder is open - skipped saving pipeline code. Ask the user to open a project folder to enable durable saves.' };
		}
		if (!pipelineName) {
			return { ok: false, message: 'No pipeline name resolved - skipped saving pipeline code.' };
		}
		if (isMountedRepo(profile)) {
			return { ok: true, message: `Pipeline code '${pipelineName}' is already in the project (mounted run environment - written directly, no copy needed).` };
		}
		const { ssh } = services();
		const paths = workspacePathsFor(profile);
		const remoteDir = `${paths.pipelines_dir.replace(/\/+$/, '')}/${pipelineName}`;
		const probe = await ssh.run(profile, `test -d '${shellEscape(remoteDir)}' && echo yes || echo no`);
		if (!(probe.exitCode === 0 && probe.stdout.includes('yes'))) {
			return { ok: false, message: `Pipeline code directory not found on target: ${remoteDir}` };
		}
		const dest = path.join(local.analysis, pipelineName);
		const summary = await copyRemoteDirInternal(profile, remoteDir, dest);
		return { ok: summary.ok, message: `Pipeline code '${pipelineName}': ${summary.message}${summary.failed ? ` (${summary.failed} failed)` : ''}` };
	} catch (err) {
		return { ok: false, message: `Pipeline code copy failed: ${(err as Error).message}` };
	}
}

/**
 * Best-effort auto-save of pipeline code at run completion. Wraps
 * `savePipelineCodeToProject`, logs the outcome, and never throws so it can be
 * safely fired from the run-completion detection points without risking the run.
 */
export async function autoSavePipelineCodeOnCompletion(profile: SshProfile, imageName: string): Promise<void> {
	try {
		const name = pipelineNameFromImage(imageName);
		const result = await savePipelineCodeToProject(profile, name);
		console.log(`${LOG_PREFIX}: auto-save code -> ${result.message}`);
	} catch (err) {
		console.warn(`${LOG_PREFIX}: auto-save code threw (ignored):`, (err as Error).message);
	}
}

/**
 * Mirror a single just-written pipeline file to the project folder. When
 * `remotePath` is inside the target's pipelines dir, write the same `content` to
 * <workspaceFolder>/analysis/<pipeline-name>/<relative>. Called on every write_file
 * so pipeline CODE stays synced in the project as it is CREATED and EDITED - not
 * only at run completion - without the user asking. Best-effort: no workspace
 * folder, a path outside the pipelines dir, or a write error all no-op. The
 * content is already in hand, so there is no SFTP round-trip.
 */
export function mirrorPipelineFileLocally(profile: SshProfile, remotePath: string, content: string): void {
	try {
		const local = localAutopipePaths();
		if (!local) { return; }
		if (isMountedRepo(profile)) { return; } // guest already wrote to the mounted local dir
		const pipelinesDir = workspacePathsFor(profile).pipelines_dir.replace(/\/+$/, '');
		if (remotePath !== pipelinesDir && !remotePath.startsWith(pipelinesDir + '/')) { return; }
		const rel = remoteRelative(pipelinesDir, remotePath);
		if (!rel || rel === '.') { return; }
		const localFile = localJoin(local.analysis, rel);
		ensureLocalDir(path.dirname(localFile));
		fs.writeFileSync(localFile, content, 'utf8');
	} catch { /* best-effort mirror */ }
}

export interface InputManifestFile {
	path: string;
	sizeBytes: number;
	sizeHuman: string;
}

export interface InputManifest {
	generatedAt: string;
	input_dir: string;
	files: InputManifestFile[];
}

/**
 * Write a manifest DESCRIBING the run's input files (paths + sizes), WITHOUT
 * copying any bytes, to
 * `<workspaceFolder>/data/<name>/manifest.json`. Input data can be huge and is
 * intentionally left on the target - the manifest is the durable record of what
 * was fed in. `name` is the run name at save time, or "inputs" at staging time
 * (before a run name exists). Never throws.
 */
export async function writeInputManifest(profile: SshProfile, name: string): Promise<StepResult> {
	try {
		const local = localAutopipePaths();
		if (!local) {
			return { ok: false, message: 'No workspace folder is open - skipped input manifest.' };
		}
		const paths = workspacePathsFor(profile);
		const entries = await listRemoteFilesWithSizes(profile, paths.input_dir);
		const files: InputManifestFile[] = entries.map(e => ({
			path: remoteRelative(paths.input_dir, e.path),
			sizeBytes: e.sizeBytes,
			sizeHuman: humanSize(e.sizeBytes),
		}));
		const manifest: InputManifest = {
			generatedAt: new Date().toISOString(),
			input_dir: paths.input_dir,
			files,
		};
		const safeName = (name || 'inputs').replace(/[\\/:*?"<>|]/g, '_');
		const runDataDir = path.join(local.data, safeName);
		ensureLocalDir(runDataDir);
		const dest = path.join(runDataDir, 'manifest.json');
		fs.writeFileSync(dest, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
		return { ok: true, message: `Wrote input manifest (${files.length} file(s), not the bytes) to ${dest}` };
	} catch (err) {
		return { ok: false, message: `Input manifest failed: ${(err as Error).message}` };
	}
}

export interface RunOutputListing {
	ok: boolean;
	message: string;
	outputDir: string;
	files: InputManifestFile[];
}

/**
 * List a run's output files (recursive, with sizes) so the AI can show the
 * user and ask which to save. Paths are relative to the run's output dir.
 */
export async function listRunOutputs(profile: SshProfile, runName: string): Promise<RunOutputListing> {
	const outputDir = resolveOutputDir(profile, runName);
	try {
		const entries = await listRemoteFilesWithSizes(profile, outputDir);
		const files: InputManifestFile[] = entries.map(e => ({
			path: remoteRelative(outputDir, e.path),
			sizeBytes: e.sizeBytes,
			sizeHuman: humanSize(e.sizeBytes),
		}));
		return { ok: true, message: `Found ${files.length} output file(s) for run '${runName}'.`, outputDir, files };
	} catch (err) {
		return { ok: false, message: `Could not list outputs for '${runName}': ${(err as Error).message}`, outputDir, files: [] };
	}
}

/** Relative POSIX paths of every file under a local dir (recursive, best-effort).
 *  The authoritative list of what a run actually produced: a remote `ls` only sees
 *  the top level, so results written into a subfolder (figures/, tables/) would
 *  otherwise be copied but never reported or opened. */
export function listLocalFiles(dir: string, prefix = ''): string[] {
	const out: string[] = [];
	try {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
			if (entry.isDirectory()) {
				out.push(...listLocalFiles(path.join(dir, entry.name), rel));
			} else if (entry.isFile()) {
				out.push(rel);
			}
		}
	} catch { /* best-effort */ }
	return out;
}

/** Largest single file copied back WITHOUT asking. Anything bigger is reported
 *  so the assistant can ask the user whether to download it - pipelines and
 *  analyses routinely produce multi-GB files (BAM, raw matrices), and pulling
 *  one unasked wastes the user's time and disk. Deliberately small: the wait is
 *  what the user notices, and a confirmed download is always available through
 *  download_results / save_results_to_project. */
export const AUTO_SAVE_MAX_FILE_BYTES = 20 * 1024 * 1024;

/**
 * Copy a completed run's outputs into `<workspaceFolder>/results/<run>/`
 * automatically, so results are on the user's disk the moment the pipeline
 * finishes instead of waiting for someone to ask. No-ops (successfully) for a
 * mounted run environment, where the guest already wrote into the project.
 * Files over AUTO_SAVE_MAX_FILE_BYTES are left behind and reported. Never throws.
 */
export async function autoSaveRunOutputsOnCompletion(profile: SshProfile, runName: string): Promise<CopySummary> {
	try {
		const local = localAutopipePaths();
		if (!local) {
			return { ok: false, message: 'No workspace folder is open - results could not be saved locally.', copied: 0, failed: 0, errors: [], skipped: [], copiedFiles: [] };
		}
		const localOutputDir = path.join(local.results, runName);
		if (isMountedRepo(profile)) {
			return { ok: true, message: 'Mounted run environment - outputs are already in the project (no copy needed).', copied: 0, failed: 0, errors: [], skipped: [], copiedFiles: listLocalFiles(localOutputDir), localDir: localOutputDir };
		}
		return await copyRemoteDirInternal(profile, resolveOutputDir(profile, runName), localOutputDir, { maxFileBytes: AUTO_SAVE_MAX_FILE_BYTES });
	} catch (err) {
		return { ok: false, message: `Automatic save failed: ${(err as Error).message}`, copied: 0, failed: 1, errors: [(err as Error).message], skipped: [], copiedFiles: [] };
	}
}

export interface SaveRunResult {
	ok: boolean;
	steps: StepResult[];
	outputsCopied: number;
	outputsFailed: number;
	outputErrors: string[];
	localOutputDir?: string;
}

/**
 * Selective save of a completed run into the project. Always saves pipeline
 * code; optionally writes the input manifest; copies each requested output
 * file (relative to the run output dir) over SFTP. `files` omitted means "do
 * not copy outputs" (code + manifest only). Never throws - failures are
 * reported per file.
 */
export async function saveResultsToProject(
	profile: SshProfile,
	runName: string,
	imageName: string,
	files: string[] | undefined,
	includeInputManifest: boolean,
): Promise<SaveRunResult> {
	const steps: StepResult[] = [];
	const outputErrors: string[] = [];
	let outputsCopied = 0;

	const local = localAutopipePaths();
	if (!local) {
		steps.push({ ok: false, message: 'No workspace folder is open - nothing was saved. Ask the user to open a project folder first.' });
		return { ok: false, steps, outputsCopied: 0, outputsFailed: 0, outputErrors: [] };
	}

	// Mounted run environment: pipeline code + outputs already live in the project
	// (the guest wrote straight to <workspaceFolder>/autopipe via /mnt), so there is
	// nothing to copy - and an SFTP copy here would read and write the same file.
	// Report success and point at where they already are.
	if (isMountedRepo(profile)) {
		const localOutputDir = path.join(local.results, runName);
		steps.push({ ok: true, message: 'Mounted run environment - pipeline code and outputs are already saved in the project (no copy needed).' });
		return { ok: true, steps, outputsCopied: 0, outputsFailed: 0, outputErrors: [], localOutputDir };
	}

	// 1) Pipeline code (always).
	steps.push(await savePipelineCodeToProject(profile, pipelineNameFromImage(imageName)));

	// 2) Input manifest (optional, default on).
	if (includeInputManifest) {
		steps.push(await writeInputManifest(profile, runName));
	}

	// 3) Selected output files (optional).
	const outputDir = resolveOutputDir(profile, runName);
	const localOutputDir = path.join(local.results, runName);
	if (files && files.length > 0) {
		const { ssh } = services();
		ensureLocalDir(localOutputDir);
		// Same transport as every other download here: ONE login, base64 over the
		// exec channel. This used to open an SFTP connection per file, which fails
		// outright on a server with SFTP disabled - and this is the path the user
		// lands on after approving a large file, so it has to be the reliable one.
		// Sizes for the integrity check. The listing is the same helper the rest of
		// this file uses; without it a corrupt copy of a file the user explicitly
		// asked for would go unnoticed - the one place that matters most.
		const sizes = new Map<string, number>();
		for (const e of await listRemoteFilesWithSizes(profile, outputDir)) {
			sizes.set(e.path, e.sizeBytes);
		}
		const batch = files.map(rel => {
			const cleanRel = String(rel).replace(/^\/+/, '');
			const remote = `${outputDir.replace(/\/+$/, '')}/${cleanRel}`;
			return {
				rel: cleanRel,
				remote,
				local: localJoin(localOutputDir, cleanRel),
				expectedBytes: sizes.get(remote),
			};
		});
		const byRemote = new Map(batch.map(b => [b.remote, b.rel]));
		try {
			const copy = await ssh.downloadFilesBase64(profile, batch.map(b => ({ remote: b.remote, local: b.local, expectedBytes: b.expectedBytes })));
			outputsCopied = copy.copied;
			outputErrors.push(...copy.errors.map(e => `${byRemote.get(e.remote) ?? e.remote}: ${e.message}`));
		} catch (err) {
			outputErrors.push(`Could not connect to copy the outputs: ${(err as Error).message}`);
		}
	}

	const ok = steps.every(s => s.ok) && outputErrors.length === 0;
	return { ok, steps, outputsCopied, outputsFailed: outputErrors.length, outputErrors, localOutputDir };
}
