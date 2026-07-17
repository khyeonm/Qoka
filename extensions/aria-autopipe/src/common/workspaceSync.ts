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
 * throwing. File copies stream over SFTP (see SshService.downloadFileSftp) so
 * multi-GB genomic outputs never buffer in memory.
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
	localDir?: string;
}

/**
 * Stream every file under `remoteDir` into `localDir` over SFTP, preserving
 * the relative tree. Best-effort per file: one failure does not abort the
 * rest, and the summary reports both counts.
 */
async function copyRemoteDirSftp(profile: SshProfile, remoteDir: string, localDir: string): Promise<CopySummary> {
	const { ssh } = services();
	const entries = await listRemoteFilesWithSizes(profile, remoteDir);
	ensureLocalDir(localDir);
	if (entries.length === 0) {
		return { ok: true, message: `No files found under ${remoteDir}.`, copied: 0, failed: 0, errors: [], localDir };
	}
	let copied = 0;
	const errors: string[] = [];
	for (const entry of entries) {
		const rel = remoteRelative(remoteDir, entry.path);
		const localFile = localJoin(localDir, rel);
		try {
			await ssh.downloadFileSftp(profile, entry.path, localFile);
			copied++;
		} catch (err) {
			errors.push(`${rel}: ${(err as Error).message}`);
		}
	}
	return {
		ok: errors.length === 0,
		message: `Copied ${copied}/${entries.length} file(s) into ${localDir}.`,
		copied,
		failed: errors.length,
		errors,
		localDir,
	};
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
		const { ssh } = services();
		const paths = workspacePathsFor(profile);
		const remoteDir = `${paths.pipelines_dir.replace(/\/+$/, '')}/${pipelineName}`;
		const probe = await ssh.run(profile, `test -d '${shellEscape(remoteDir)}' && echo yes || echo no`);
		if (!(probe.exitCode === 0 && probe.stdout.includes('yes'))) {
			return { ok: false, message: `Pipeline code directory not found on target: ${remoteDir}` };
		}
		const dest = path.join(local.pipelines, pipelineName);
		const summary = await copyRemoteDirSftp(profile, remoteDir, dest);
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
		for (const rel of files) {
			const cleanRel = String(rel).replace(/^\/+/, '');
			const remoteFile = `${outputDir.replace(/\/+$/, '')}/${cleanRel}`;
			const localFile = localJoin(localOutputDir, cleanRel);
			try {
				await ssh.downloadFileSftp(profile, remoteFile, localFile);
				outputsCopied++;
			} catch (err) {
				outputErrors.push(`${cleanRel}: ${(err as Error).message}`);
			}
		}
	}

	const ok = steps.every(s => s.ok) && outputErrors.length === 0;
	return { ok, steps, outputsCopied, outputsFailed: outputErrors.length, outputErrors, localOutputDir };
}
