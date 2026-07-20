/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Hybrid git backend for Qoka's "Versions" feature.
 *
 * The rest of the extension talks to a single `git(args, cwd)` dispatcher in
 * vcsService.ts. That dispatcher asks {@link resolveGit} which mode to run in:
 *
 *  - **native**: a system `git` binary was found → spawn it exactly like before
 *    (byte-for-byte identical behavior for users who have git installed).
 *  - **iso**: no system git → {@link runIso} interprets the same argv and
 *    fulfills it with isomorphic-git (pure JS), returning a git-compatible
 *    stdout string that vcsService.ts's existing parsers already understand.
 *
 * Only the commands vcsService.ts actually issues are implemented in iso mode.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import * as isogit from 'isomorphic-git';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

export type GitMode = { mode: 'native'; gitPath: string } | { mode: 'iso' };

let cachedMode: GitMode | undefined;

/** Can we run `<bin> --version` without error? Used to confirm a git binary is
 *  real and executable. Running `git --version` has no side effects. */
async function canRun(bin: string): Promise<boolean> {
	try {
		await execFileAsync(bin, ['--version'], { timeout: 5000 });
		return true;
	} catch {
		return false;
	}
}

async function detectWindows(): Promise<GitMode> {
	// System git often isn't on a GUI app's PATH; probe the usual install spots.
	if (await canRun('git')) {
		return { mode: 'native', gitPath: 'git' };
	}
	const localAppData = process.env.LOCALAPPDATA;
	const userProfile = process.env.USERPROFILE;
	const candidates = [
		'C:\\Program Files\\Git\\cmd\\git.exe',
		'C:\\Program Files (x86)\\Git\\cmd\\git.exe',
		localAppData ? path.join(localAppData, 'Programs', 'Git', 'cmd', 'git.exe') : undefined,
		userProfile ? path.join(userProfile, '.local', 'bin', 'git.exe') : undefined,
	].filter((c): c is string => typeof c === 'string');

	for (const candidate of candidates) {
		if (fs.existsSync(candidate) && (await canRun(candidate))) {
			return { mode: 'native', gitPath: candidate };
		}
	}
	return { mode: 'iso' };
}

async function detectMac(): Promise<GitMode> {
	// IMPORTANT: never execute /usr/bin/git just to probe. On a Mac without the
	// Command Line Tools it's a stub that can pop a GUI installer dialog.

	// (a) Real, standalone git binaries (Homebrew) - safe to run.
	for (const candidate of ['/opt/homebrew/bin/git', '/usr/local/bin/git']) {
		if (fs.existsSync(candidate) && (await canRun(candidate))) {
			return { mode: 'native', gitPath: candidate };
		}
	}

	// (b) Ask the login shell where git is (GUI apps inherit a minimal PATH).
	//     Only trust a path that ISN'T the /usr/bin/git stub.
	try {
		const shell = process.env.SHELL || '/bin/zsh';
		const { stdout } = await execFileAsync(shell, ['-lc', 'command -v git'], { timeout: 5000 });
		const found = stdout.split('\n')[0].trim();
		if (found && found !== '/usr/bin/git' && fs.existsSync(found) && (await canRun(found))) {
			return { mode: 'native', gitPath: found };
		}
	} catch {
		// no usable login-shell git
	}

	// (c) `xcode-select -p` is safe (it prints the path, never installs). If it
	//     exits 0 with a path, the Command Line Tools are present and the
	//     /usr/bin/git stub is backed by a real git.
	try {
		const { stdout } = await execFileAsync('xcode-select', ['-p'], { timeout: 5000 });
		if (stdout.trim().length > 0) {
			return { mode: 'native', gitPath: '/usr/bin/git' };
		}
	} catch {
		// Command Line Tools not installed
	}

	return { mode: 'iso' };
}

async function detectLinux(): Promise<GitMode> {
	if (await canRun('git')) {
		return { mode: 'native', gitPath: 'git' };
	}
	return { mode: 'iso' };
}

/** Decide once (and cache) whether to use the system git binary or the pure-JS
 *  isomorphic-git fallback. Detection failure degrades to iso. */
export async function resolveGit(): Promise<GitMode> {
	if (cachedMode) {
		return cachedMode;
	}
	try {
		if (process.platform === 'win32') {
			cachedMode = await detectWindows();
		} else if (process.platform === 'darwin') {
			cachedMode = await detectMac();
		} else {
			cachedMode = await detectLinux();
		}
	} catch {
		cachedMode = { mode: 'iso' };
	}
	return cachedMode;
}

// ---------------------------------------------------------------------------
// iso mode - shared helpers
// ---------------------------------------------------------------------------

type StatusRow = [string, number, number, number];

function nl(lines: string[]): string {
	return lines.length ? lines.join('\n') + '\n' : '';
}

function isBinary(text: string): boolean {
	return text.indexOf('\0') !== -1;
}

/** Resolve a ref name (HEAD, tag, branch) to an oid; pass an oid through. */
async function toOid(dir: string, ref: string): Promise<string> {
	try {
		return await isogit.resolveRef({ fs, dir, ref });
	} catch {
		return ref; // already an oid
	}
}

async function blobTextByOid(dir: string, oid: string): Promise<string> {
	const { blob } = await isogit.readBlob({ fs, dir, oid });
	return Buffer.from(blob).toString('utf8');
}

/** Blob text for `filepath` as it exists in commit `commitOid`; '' if absent. */
async function blobTextAt(dir: string, commitOid: string, filepath: string): Promise<string> {
	try {
		const { blob } = await isogit.readBlob({ fs, dir, oid: commitOid, filepath });
		return Buffer.from(blob).toString('utf8');
	} catch {
		return '';
	}
}

function readWorkFile(dir: string, filepath: string): string {
	try {
		return fs.readFileSync(path.join(dir, filepath), 'utf8');
	} catch {
		return '';
	}
}

// ---------------------------------------------------------------------------
// Minimal line diff (LCS) - powers numstat counts and the diff-text patch.
// No heavy dependency; guarded against pathological O(n*m) blow-ups.
// ---------------------------------------------------------------------------

type DiffOp = { t: ' ' | '-' | '+'; line: string };

function splitLines(text: string): string[] {
	if (text === '') {
		return [];
	}
	const lines = text.split('\n');
	// Drop the trailing '' produced when the file ends in a newline, so line
	// counts reflect content lines (matches how humans read a diff).
	if (lines.length && lines[lines.length - 1] === '') {
		lines.pop();
	}
	return lines;
}

function diffOps(oldText: string, newText: string): DiffOp[] {
	const a = splitLines(oldText);
	const b = splitLines(newText);
	const n = a.length;
	const m = b.length;

	// Guard: for very large inputs skip the DP table and report a full rewrite.
	if (n > 4000 || m > 4000 || n * m > 4_000_000) {
		const ops: DiffOp[] = [];
		for (const line of a) { ops.push({ t: '-', line }); }
		for (const line of b) { ops.push({ t: '+', line }); }
		return ops;
	}

	// LCS length table.
	const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
	for (let i = n - 1; i >= 0; i--) {
		for (let j = m - 1; j >= 0; j--) {
			dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
		}
	}

	const ops: DiffOp[] = [];
	let i = 0;
	let j = 0;
	while (i < n && j < m) {
		if (a[i] === b[j]) {
			ops.push({ t: ' ', line: a[i] });
			i++;
			j++;
		} else if (dp[i + 1][j] >= dp[i][j + 1]) {
			ops.push({ t: '-', line: a[i] });
			i++;
		} else {
			ops.push({ t: '+', line: b[j] });
			j++;
		}
	}
	while (i < n) { ops.push({ t: '-', line: a[i++] }); }
	while (j < m) { ops.push({ t: '+', line: b[j++] }); }
	return ops;
}

function countDiff(oldText: string, newText: string): { add: number; del: number } {
	let add = 0;
	let del = 0;
	for (const op of diffOps(oldText, newText)) {
		if (op.t === '+') { add++; }
		else if (op.t === '-') { del++; }
	}
	return { add, del };
}

/** A whole-file unified diff (all context in one hunk). Only consumed by the AI
 *  summariser as free text, so exact hunk headers don't need to be precise. */
function unifiedDiff(filepath: string, oldText: string, newText: string): string {
	const ops = diffOps(oldText, newText);
	if (!ops.some(op => op.t !== ' ')) {
		return '';
	}
	const a = splitLines(oldText);
	const b = splitLines(newText);
	let out = `diff --git a/${filepath} b/${filepath}\n--- a/${filepath}\n+++ b/${filepath}\n`;
	out += `@@ -1,${a.length} +1,${b.length} @@\n`;
	for (const op of ops) {
		out += `${op.t}${op.line}\n`;
	}
	return out;
}

// ---------------------------------------------------------------------------
// iso mode - porcelain status (statusMatrix -> "XY path" lines)
// ---------------------------------------------------------------------------

/**
 * Map an isomorphic-git status row to a git porcelain two-char XY code.
 * statusMatrix columns: HEAD (0 absent / 1 present), WORKDIR (0 absent /
 * 1 == HEAD / 2 != HEAD), STAGE (0 absent / 1 == HEAD / 2 == WORKDIR /
 * 3 != both). Returns null for unmodified rows (nothing to print).
 *
 * vcsService's parser only inspects the code for '??', 'R', 'A', 'D' (else
 * modified), so we only need those buckets to be correct.
 */
function porcelainCode(head: number, workdir: number, stage: number): string | null {
	// Untracked: absent from HEAD and index.
	if (head === 0 && stage === 0) {
		return workdir === 0 ? null : '??';
	}
	// Added: absent from HEAD but present in the index.
	if (head === 0) {
		if (workdir === 0) { return 'AD'; }         // staged add, then deleted on disk
		return stage === 3 ? 'AM' : 'A ';           // staged add (+ unstaged tweak)
	}
	// Tracked in HEAD from here on.
	if (workdir === 0) {
		// Deleted on disk. stage 0 -> deletion staged; else not staged.
		return stage === 0 ? 'D ' : ' D';
	}
	if (workdir === 1) {
		// Working copy matches HEAD.
		if (stage === 1) { return null; }           // unmodified
		if (stage === 0) { return 'D '; }           // staged deletion (file restored on disk)
		return 'M ';                                 // staged change reverted on disk
	}
	// workdir === 2: differs from HEAD.
	if (stage === 1) { return ' M'; }               // modified, unstaged
	if (stage === 0) { return 'MD'; }               // modified, then staged-deleted
	if (stage === 2) { return 'M '; }               // modified, staged
	return 'MM';                                     // staged + further unstaged edits
}

async function isoStatusPorcelain(dir: string): Promise<string> {
	const matrix = (await isogit.statusMatrix({ fs, dir })) as StatusRow[];
	const lines: string[] = [];
	for (const row of matrix) {
		const filepath = row[0];
		const code = porcelainCode(row[1], row[2], row[3]);
		if (code) {
			lines.push(`${code} ${filepath}`);
		}
	}
	return nl(lines);
}

// ---------------------------------------------------------------------------
// iso mode - staging (add)
// ---------------------------------------------------------------------------

async function isoAdd(dir: string, args: string[]): Promise<string> {
	if (args.includes('-A')) {
		// Stage everything, including deletions (git.add doesn't remove).
		const matrix = (await isogit.statusMatrix({ fs, dir })) as StatusRow[];
		for (const row of matrix) {
			const filepath = row[0];
			const head = row[1];
			const workdir = row[2];
			const stage = row[3];
			if (head === 1 && workdir === 1 && stage === 1) {
				continue; // unmodified
			}
			if (workdir === 0) {
				if (head !== 0) {
					await isogit.remove({ fs, dir, filepath });
				}
			} else {
				await isogit.add({ fs, dir, filepath });
			}
		}
		return '';
	}

	// `add -- <paths>`: stage the given paths (or remove them if gone from disk).
	const sepIdx = args.indexOf('--');
	const paths = sepIdx >= 0 ? args.slice(sepIdx + 1) : args.slice(1);
	for (const p of paths) {
		if (fs.existsSync(path.join(dir, p))) {
			await isogit.add({ fs, dir, filepath: p });
		} else {
			await isogit.remove({ fs, dir, filepath: p }).catch(() => { /* not tracked */ });
		}
	}
	return '';
}

// ---------------------------------------------------------------------------
// iso mode - diff
// ---------------------------------------------------------------------------

/** `diff --cached --name-only`: files whose index entry differs from HEAD. */
async function isoDiffCachedNameOnly(dir: string): Promise<string> {
	const matrix = (await isogit.statusMatrix({ fs, dir })) as StatusRow[];
	const out: string[] = [];
	for (const row of matrix) {
		const head = row[1];
		const stage = row[3];
		const indexEqualsHead = (head === 0 && stage === 0) || (head === 1 && stage === 1);
		if (!indexEqualsHead) {
			out.push(row[0]);
		}
	}
	return nl(out);
}

/** `diff --numstat HEAD`: per tracked file changed vs HEAD -> "add<TAB>del<TAB>path". */
async function isoDiffNumstatHead(dir: string): Promise<string> {
	let head: string;
	try {
		head = await isogit.resolveRef({ fs, dir, ref: 'HEAD' });
	} catch {
		return ''; // no commits yet
	}
	const matrix = (await isogit.statusMatrix({ fs, dir })) as StatusRow[];
	const lines: string[] = [];
	for (const row of matrix) {
		const filepath = row[0];
		const h = row[1];
		const workdir = row[2];
		const stage = row[3];
		if (h === 0 && stage === 0) {
			continue; // untracked - git diff HEAD ignores these
		}
		if (h === 1 && workdir === 1 && stage === 1) {
			continue; // unmodified
		}
		const oldText = h === 1 ? await blobTextAt(dir, head, filepath) : '';
		const newText = workdir === 0 ? '' : readWorkFile(dir, filepath);
		if (oldText === newText) {
			continue;
		}
		if (isBinary(oldText) || isBinary(newText)) {
			lines.push(`-\t-\t${filepath}`);
			continue;
		}
		const { add, del } = countDiff(oldText, newText);
		lines.push(`${add}\t${del}\t${filepath}`);
	}
	return nl(lines);
}

/** `diff HEAD [-- paths]`: unified patch text (fed to the AI summariser). */
async function isoDiffHead(dir: string, args: string[]): Promise<string> {
	let head: string;
	try {
		head = await isogit.resolveRef({ fs, dir, ref: 'HEAD' });
	} catch {
		return '';
	}
	const sepIdx = args.indexOf('--');
	const scope = sepIdx >= 0 ? new Set(args.slice(sepIdx + 1)) : undefined;

	const matrix = (await isogit.statusMatrix({ fs, dir })) as StatusRow[];
	let out = '';
	for (const row of matrix) {
		const filepath = row[0];
		const h = row[1];
		const workdir = row[2];
		const stage = row[3];
		if (h === 0 && stage === 0) {
			continue; // untracked
		}
		if (h === 1 && workdir === 1 && stage === 1) {
			continue; // unmodified
		}
		if (scope && !scope.has(filepath)) {
			continue;
		}
		const oldText = h === 1 ? await blobTextAt(dir, head, filepath) : '';
		const newText = workdir === 0 ? '' : readWorkFile(dir, filepath);
		if (oldText === newText) {
			continue;
		}
		if (isBinary(oldText) || isBinary(newText)) {
			out += `diff --git a/${filepath} b/${filepath}\nBinary files differ\n`;
			continue;
		}
		out += unifiedDiff(filepath, oldText, newText);
	}
	return out;
}

async function isoDiff(dir: string, args: string[]): Promise<string> {
	if (args.includes('--cached') && args.includes('--name-only')) {
		return isoDiffCachedNameOnly(dir);
	}
	if (args.includes('--numstat')) {
		return isoDiffNumstatHead(dir);
	}
	return isoDiffHead(dir, args);
}

// ---------------------------------------------------------------------------
// iso mode - commit / log
// ---------------------------------------------------------------------------

async function isoCommit(dir: string, message: string): Promise<string> {
	const name = ((await isogit.getConfig({ fs, dir, path: 'user.name' })) as string | undefined) || 'Qoka User';
	const email = ((await isogit.getConfig({ fs, dir, path: 'user.email' })) as string | undefined) || 'aria@localhost';
	const sha = await isogit.commit({
		fs,
		dir,
		message,
		author: { name, email },
		committer: { name, email },
	});
	return sha + '\n';
}

async function isoLog(dir: string, args: string[]): Promise<string> {
	const nIdx = args.indexOf('-n');
	const depth = nIdx >= 0 ? parseInt(args[nIdx + 1], 10) : undefined;
	const fmtArg = args.find(a => a.startsWith('--pretty=format:')) || '--pretty=format:%H';
	const fmt = fmtArg.slice('--pretty=format:'.length);

	const commits = await isogit.log({ fs, dir, depth });
	const lines = commits.map(entry => {
		const subject = entry.commit.message.split('\n')[0];
		// split/join (not String.replace) so a '$' in the subject isn't treated
		// as a replacement pattern.
		let line = fmt;
		line = line.split('%H').join(entry.oid);
		line = line.split('%ct').join(String(entry.commit.committer.timestamp));
		line = line.split('%s').join(subject);
		return line;
	});
	return lines.join('\n');
}

// ---------------------------------------------------------------------------
// iso mode - commit-vs-parent diff (powers `show` variants)
// ---------------------------------------------------------------------------

interface CommitDiffEntry {
	filepath: string;
	type: 'A' | 'M' | 'D';
	newOid?: string;
	oldOid?: string;
}

/** Files that differ between `ref`'s commit tree and its first parent (or, for a
 *  root commit, everything the commit introduces). */
async function diffCommitVsParent(dir: string, ref: string): Promise<CommitDiffEntry[]> {
	const oid = await toOid(dir, ref);
	const { commit } = await isogit.readCommit({ fs, dir, oid });
	const parent = commit.parent && commit.parent.length > 0 ? commit.parent[0] : undefined;

	const results: CommitDiffEntry[] = [];
	const trees = parent
		? [isogit.TREE({ ref: parent }), isogit.TREE({ ref: oid })]
		: [isogit.TREE({ ref: oid })];

	await isogit.walk({
		fs,
		dir,
		trees,
		map: async (filepath: string, entries: Array<isogit.WalkerEntry | null>) => {
			if (filepath === '.') {
				return undefined;
			}
			if (parent) {
				const before = entries[0];
				const after = entries[1];
				const beforeType = before ? await before.type() : undefined;
				const afterType = after ? await after.type() : undefined;
				if (beforeType === 'tree' || afterType === 'tree') {
					return undefined; // descend into dirs; don't record them
				}
				const beforeOid = before ? await before.oid() : undefined;
				const afterOid = after ? await after.oid() : undefined;
				if (beforeOid === afterOid) {
					return undefined; // unchanged
				}
				if (!beforeOid && afterOid) {
					results.push({ filepath, type: 'A', newOid: afterOid });
				} else if (beforeOid && !afterOid) {
					results.push({ filepath, type: 'D', oldOid: beforeOid });
				} else {
					results.push({ filepath, type: 'M', newOid: afterOid, oldOid: beforeOid });
				}
			} else {
				const after = entries[0];
				const afterType = after ? await after.type() : undefined;
				if (afterType === 'tree') {
					return undefined;
				}
				const afterOid = after ? await after.oid() : undefined;
				if (afterOid) {
					results.push({ filepath, type: 'A', newOid: afterOid });
				}
			}
			return undefined;
		},
	});
	return results;
}

/** `show --stat --format= <hash>`: the parser only reads "(\d+) files? changed". */
async function isoShowStat(dir: string, ref: string): Promise<string> {
	const entries = await diffCommitVsParent(dir, ref);
	const n = entries.length;
	return `${n} file${n === 1 ? '' : 's'} changed\n`;
}

/** `show --name-status --format= --root <hash>` -> "A\tpath" / "M\tpath" / "D\tpath". */
async function isoShowNameStatus(dir: string, ref: string): Promise<string> {
	const entries = await diffCommitVsParent(dir, ref);
	return nl(entries.map(e => `${e.type}\t${e.filepath}`));
}

/** `show --numstat --format= --root <hash>` -> "add\tdel\tpath". */
async function isoShowNumstat(dir: string, ref: string): Promise<string> {
	const entries = await diffCommitVsParent(dir, ref);
	const lines: string[] = [];
	for (const e of entries) {
		const oldText = e.oldOid ? await blobTextByOid(dir, e.oldOid) : '';
		const newText = e.newOid ? await blobTextByOid(dir, e.newOid) : '';
		if (isBinary(oldText) || isBinary(newText)) {
			lines.push(`-\t-\t${e.filepath}`);
			continue;
		}
		const { add, del } = countDiff(oldText, newText);
		lines.push(`${add}\t${del}\t${e.filepath}`);
	}
	return nl(lines);
}

/** `show <ref>:<path>` -> the file's content at that ref. */
async function isoShowBlob(dir: string, spec: string): Promise<string> {
	const idx = spec.indexOf(':');
	const ref = spec.slice(0, idx);
	const filepath = spec.slice(idx + 1);
	const oid = await toOid(dir, ref);
	const { blob } = await isogit.readBlob({ fs, dir, oid, filepath });
	return Buffer.from(blob).toString('utf8');
}

async function isoShow(dir: string, args: string[]): Promise<string> {
	const rest = args.slice(1);

	// `show <ref>:<path>` - the only variant with no flags and a colon token.
	if (rest.length === 1 && !rest[0].startsWith('--') && rest[0].includes(':')) {
		return isoShowBlob(dir, rest[0]);
	}

	const flags = rest.filter(a => a.startsWith('--'));
	const positional = rest.filter(a => !a.startsWith('--'));
	const hash = positional[positional.length - 1];

	if (flags.includes('--stat')) {
		return isoShowStat(dir, hash);
	}
	if (flags.includes('--name-status')) {
		return isoShowNameStatus(dir, hash);
	}
	if (flags.includes('--numstat')) {
		return isoShowNumstat(dir, hash);
	}
	throw new Error(`iso git: unsupported show invocation: ${args.join(' ')}`);
}

// ---------------------------------------------------------------------------
// iso mode - tag / reset / config / init / rev-parse
// ---------------------------------------------------------------------------

/** `tag <name> HEAD`: create a lightweight tag pointing at the ref's oid. */
async function isoTag(dir: string, args: string[]): Promise<string> {
	const name = args[1];
	const ref = args[2] || 'HEAD';
	const oid = await toOid(dir, ref);
	await isogit.writeRef({ fs, dir, ref: `refs/tags/${name}`, value: oid, force: true });
	return '';
}

/**
 * `reset --mixed <hash>`: move the current branch (HEAD) to <hash> and rebuild
 * the index to match that commit's tree, WITHOUT touching working files. The
 * working tree then shows up as unstaged changes vs the restored snapshot -
 * exactly the semantics restoreSnapshot relies on.
 */
async function isoReset(dir: string, args: string[]): Promise<string> {
	const hash = args[args.length - 1];
	const oid = await toOid(dir, hash);

	// Move HEAD by repointing the current branch (stay on the branch so future
	// snapshots keep advancing it). Detached HEAD -> write HEAD directly.
	let branch: string | void;
	try {
		branch = await isogit.currentBranch({ fs, dir, fullname: false });
	} catch {
		branch = undefined;
	}
	if (branch) {
		await isogit.writeRef({ fs, dir, ref: `refs/heads/${branch}`, value: oid, force: true });
	} else {
		await isogit.writeRef({ fs, dir, ref: 'HEAD', value: oid, force: true });
	}

	// Rebuild the index to match <oid>'s tree, leaving the working tree alone.
	// resetIndex reads each path from <oid> into the index (or drops it if the
	// path isn't in <oid>) and never writes to the working directory.
	const matrix = (await isogit.statusMatrix({ fs, dir })) as StatusRow[];
	for (const row of matrix) {
		try {
			await isogit.resetIndex({ fs, dir, filepath: row[0], ref: oid });
		} catch {
			// best-effort per file
		}
	}
	return '';
}

async function isoConfig(dir: string, args: string[]): Promise<string> {
	// Read of global config: iso has no global identity, so report "unset" ('')
	// and let the caller write a repo-local identity instead.
	if (args[1] === '--global') {
		return '';
	}
	// Write: `config <key> <value>`.
	const key = args[1];
	const value = args[2];
	await isogit.setConfig({ fs, dir, path: key, value });
	return '';
}

// ---------------------------------------------------------------------------
// iso mode - top-level dispatcher
// ---------------------------------------------------------------------------

/**
 * Interpret a git argv the way vcsService.ts issues it, using isomorphic-git,
 * and return a stdout string its parsers already understand. Unknown commands
 * throw (callers wrap git() in try/catch), matching how a failed native git
 * invocation would surface.
 */
export async function runIso(args: string[], cwd: string): Promise<string> {
	const cmd = args[0];
	switch (cmd) {
		case 'init':
			await isogit.init({ fs, dir: cwd, defaultBranch: 'master' });
			return '';
		case 'config':
			return isoConfig(cwd, args);
		case 'rev-parse':
			// Only used as `rev-parse HEAD`; throw when there are no commits so the
			// caller's catch reads it as "no snapshots yet".
			return (await isogit.resolveRef({ fs, dir: cwd, ref: args[args.length - 1] })) + '\n';
		case 'status':
			return isoStatusPorcelain(cwd);
		case 'add':
			return isoAdd(cwd, args);
		case 'diff':
			return isoDiff(cwd, args);
		case 'commit': {
			const mIdx = args.indexOf('-m');
			const message = mIdx >= 0 ? args[mIdx + 1] : '';
			return isoCommit(cwd, message);
		}
		case 'log':
			return isoLog(cwd, args);
		case 'show':
			return isoShow(cwd, args);
		case 'tag':
			return isoTag(cwd, args);
		case 'reset':
			return isoReset(cwd, args);
		default:
			throw new Error(`iso git: unsupported command: ${args.join(' ')}`);
	}
}
