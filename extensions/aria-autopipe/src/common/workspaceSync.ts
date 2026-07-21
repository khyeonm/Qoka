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
 * Local layout mirrors the remote convention (workspacePathsFor):
 *   <workspaceFolder>/autopipe/pipelines/<name>/       pipeline code
 *   <workspaceFolder>/autopipe/pipelines_input/*.manifest.json   input manifests (no bytes)
 *   <workspaceFolder>/autopipe/pipelines_output/<run>/  saved result files
 */

const LOG_PREFIX = '[aria-autopipe] workspaceSync';

export interface LocalAutopipePaths {
	base: string;
	pipelines: string;
	input: string;
	output: string;
}

/** First workspace folder's fsPath, or undefined when no folder is open. */
export function workspaceFolderPath(): string | undefined {
	return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

/**
 * Resolve the local `<workspaceFolder>/autopipe/` base and its subdirs, or
 * undefined when no workspace folder is open. Does NOT create anything - call
 * `ensureLocalDir` at copy time so we never scaffold an empty tree.
 */
export function localAutopipePaths(): LocalAutopipePaths | undefined {
	const folder = workspaceFolderPath();
	if (!folder) {
		return undefined;
	}
	const base = path.join(folder, 'autopipe');
	return {
		base,
		pipelines: path.join(base, 'pipelines'),
		input: path.join(base, 'pipelines_input'),
		output: path.join(base, 'pipelines_output'),
	};
}

/** `mkdir -p` for a local directory. */
export function ensureLocalDir(dir: string): void {
	fs.mkdirSync(dir, { recursive: true });
}

/** Local `analysis/` dir (quick run_code outputs), or undefined with no folder. */
export function localAnalysisDir(): string | undefined {
	const folder = workspaceFolderPath();
	return folder ? path.join(folder, 'analysis') : undefined;
}

/**
 * True when the run target's workspace lives on a WSL Windows mount
 * (`/mnt/<drive>/…`) - i.e. the guest writes straight to the user's local disk.
 * In that "mounted" mode the SFTP save/mirror steps are redundant (and would
 * copy a file onto itself over SFTP), so callers skip them.
 */
export function isMountedRepo(profile: SshProfile): boolean {
	return /^\/mnt\/[a-z]\//i.test(profile.repo_path);
}

/**
 * Create Qoka's local project scaffold on first launch:
 *   <workspaceFolder>/autopipe/{pipelines,pipelines_input,pipelines_output}/
 *   <workspaceFolder>/analysis/
 * so the mounted run environment has the dirs it writes into and the Explorer
 * shows them. Each gets a `.gitkeep` so the empty tree survives git. Idempotent;
 * no-ops without an open folder.
 */
export function ensureWorkspaceScaffold(root?: string): void {
	const folder = root ?? workspaceFolderPath();
	if (!folder) { return; }
	const base = path.join(folder, 'autopipe');
	const dirs = [
		path.join(base, 'pipelines'),
		path.join(base, 'pipelines_input'),
		path.join(base, 'pipelines_output'),
		path.join(folder, 'analysis'),
	];
	for (const d of dirs) {
		try {
			fs.mkdirSync(d, { recursive: true });
			const keep = path.join(d, '.gitkeep');
			if (!fs.existsSync(keep)) { fs.writeFileSync(keep, ''); }
		} catch { /* best-effort */ }
	}
	try {
		const readme = path.join(folder, 'analysis', 'README.md');
		if (!fs.existsSync(readme)) { fs.writeFileSync(readme, ANALYSIS_README, 'utf8'); }
	} catch { /* best-effort */ }
}

const ANALYSIS_README = [
	'# analysis',
	'',
	'Results from quick one-off code runs (the **qoka-run** `run_code` tool) land',
	'here, one folder per run: `analysis/<run-id>/`. Output files too large to show',
	'in chat - big tables, images/plots - are written here; open them from the',
	'Explorer.',
	'',
].join('\n');

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
		return { ok: true, message: `No files found under ${remoteDir}.`, copied: 0, failed: 0, errors: [], skipped: [], localDir };
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
 * `<workspaceFolder>/autopipe/pipelines/<name>/`. Code is small, so this is
 * always safe to run without prompting. No-ops with a clear message when there
 * is no workspace folder. Never throws.
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
		const dest = path.join(local.pipelines, pipelineName);
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
 * <workspaceFolder>/autopipe/pipelines/<relative>. Called on every write_file so
 * pipeline CODE stays synced in the project as it is CREATED and EDITED - not
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
		const localFile = localJoin(local.pipelines, rel);
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
 * `<workspaceFolder>/autopipe/pipelines_input/<name>.manifest.json`. Input
 * data can be huge and is intentionally left on the target - the manifest is
 * the durable record of what was fed in. Never throws.
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
		ensureLocalDir(local.input);
		const safeName = (name || 'inputs').replace(/[\\/:*?"<>|]/g, '_');
		const dest = path.join(local.input, `${safeName}.manifest.json`);
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

/** Largest single file copied back WITHOUT asking. Anything bigger is reported
 *  so the assistant can ask the user whether to download it - pipelines and
 *  analyses routinely produce multi-GB files (BAM, raw matrices), and pulling
 *  one unasked wastes the user's time and disk. Deliberately small: the wait is
 *  what the user notices, and a confirmed download is always available through
 *  download_results / save_results_to_project. */
export const AUTO_SAVE_MAX_FILE_BYTES = 20 * 1024 * 1024;

/**
 * Copy a completed run's outputs into `<workspaceFolder>/autopipe/pipelines_output/<run>/`
 * automatically, so results are on the user's disk the moment the pipeline
 * finishes instead of waiting for someone to ask. No-ops (successfully) for a
 * mounted run environment, where the guest already wrote into the project.
 * Files over AUTO_SAVE_MAX_FILE_BYTES are left behind and reported. Never throws.
 */
export async function autoSaveRunOutputsOnCompletion(profile: SshProfile, runName: string): Promise<CopySummary> {
	try {
		const local = localAutopipePaths();
		if (!local) {
			return { ok: false, message: 'No workspace folder is open - results could not be saved locally.', copied: 0, failed: 0, errors: [], skipped: [] };
		}
		const localOutputDir = path.join(local.output, runName);
		if (isMountedRepo(profile)) {
			return { ok: true, message: 'Mounted run environment - outputs are already in the project (no copy needed).', copied: 0, failed: 0, errors: [], skipped: [], localDir: localOutputDir };
		}
		return await copyRemoteDirInternal(profile, resolveOutputDir(profile, runName), localOutputDir, { maxFileBytes: AUTO_SAVE_MAX_FILE_BYTES });
	} catch (err) {
		return { ok: false, message: `Automatic save failed: ${(err as Error).message}`, copied: 0, failed: 1, errors: [(err as Error).message], skipped: [] };
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
		const localOutputDir = path.join(local.output, runName);
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
	const localOutputDir = path.join(local.output, runName);
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
