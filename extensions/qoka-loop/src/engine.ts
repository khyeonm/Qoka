/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The deterministic controller (loop_engine_design.md sections 14-15). This module is
// intentionally vscode-free: all paths and the persist callback are injected, so the
// control logic can be unit-tested headlessly. The engine RUNS the loop and JUDGES each
// iteration with the sha256-locked evaluator; it never edits the work code - that is the
// sub-agent's job, fed the previous verdict as feedback.

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { execFileSync } from 'child_process';
import { LoopRun, LoopHistoryEntry } from './schema';

/** How many identical failures in a row count as "no progress". */
export const NO_PROGRESS_N = 3;

/** What a single sub-agent turn returns to the engine. */
export interface AgentResult {
	output: string;
	exitCode: number | null;
	/** Set when the turn hit an environment problem (auth/quota/CLI down) - the engine
	 *  pauses instead of counting it as a failure. */
	envError?: boolean;
	error?: string;
	/** The literal RAW run_code source the sub-agent executed this turn, saved as a clean source
	 *  file so the Loops tab shows the real work - not just the narration. Undefined when none. */
	code?: string;
	/** Language of `code` (python/node/...), for the saved file's extension. */
	codeLanguage?: string;
	/** Tokens used this turn (input + output), accumulated into the run's budget for live display. */
	tokens?: number;
}

/** A sub-agent turn: does the work for one iteration, given the previous verdict as
 *  feedback. Injected so the engine can be tested with a mock and run with a real
 *  headless CLI (agent_step, M1b). */
export type AgentStep = (run: LoopRun, feedback: string | undefined) => Promise<AgentResult>;

/** The evaluator's deterministic verdict. */
export interface Verdict { pass: boolean; detail: string; }

export type LoopOutcome = 'success' | 'failed-structural' | 'failed-budget' | 'paused' | 'stopped';

/** Runs a script and returns its result. Injected so the evaluator executes WHERE the work
 *  happened: the extension provides a runner that executes in the RUN environment (SSH/WSL/
 *  vfkit), the same place the sub-agent's run_code wrote its files; the test provides a local
 *  one. Without this the engine would run the evaluator locally and miss a remote file. */
export type ScriptRunner = (script: string, language: string | undefined) => Promise<{ stdout: string; stderr: string; exitCode: number | null }>;

export interface RunOptions {
	/** <project>/.qoka/loops - where the locked evaluator artifact is written. */
	loopDir: string;
	/** Working directory the evaluator (and the sub-agent's work) runs in. */
	cwd: string;
	/** Execute the locked evaluator in the run environment (see ScriptRunner). */
	evaluatorRunner: ScriptRunner;
	/** Persist the run after every state change (the resume point). */
	persist: (run: LoopRun) => void;
	/** Checked at the top of every iteration; returning true stops the loop cleanly (status
	 *  'stopped'). Lets the user cancel a running loop from the chat (stop_loop tool). */
	shouldStop?: () => boolean;
	/** VISIBLE git-versioned code folder (loops/<folder>/code): each iteration overwrites
	 *  solution.<ext> and commits it, so the working tree is the latest code and `git log` is the full
	 *  attempt history (pass + fail). Unset (tests) -> no code recording. */
	codeDir?: string;
	/** This loop's results folder (loops/<folder>/results): cleared before each iteration so, when the
	 *  loop ends, only the FINAL run's outputs remain. Unset -> not cleared. */
	resultsDir?: string;
	/** git binary for code versioning (bundled MinGit path on Windows, else 'git'). Defaults to 'git'. */
	gitPath?: string;
	/** Diagnostics sink (the "Qoka Loop" output channel). Injected so the engine stays vscode-free. */
	log?: (msg: string) => void;
}

function sha256(s: string): string {
	return crypto.createHash('sha256').update(s).digest('hex');
}

function evaluatorPath(run: LoopRun, loopDir: string): string {
	const lang = run.spec.evaluator.language;
	const ext = lang === 'python' ? 'py' : lang === 'node' ? 'js' : 'sh';
	return path.join(loopDir, run.id, `evaluator.${ext}`);
}

/** Extension for a run_code language, for the saved iteration source file. */
function codeExt(language?: string): string {
	switch (language) {
		case 'python': return 'py';
		case 'node': case 'javascript': case 'js': return 'js';
		case 'bash': case 'sh': case 'shell': return 'sh';
		case 'r': case 'R': return 'R';
		default: return 'txt';
	}
}

/** A clean git environment: drop any inherited GIT_DIR / GIT_WORK_TREE (etc.) so our `-C codeDir`
 *  operations always target the loop's OWN nested repo, never the workspace repo aria-vcs manages. */
function gitEnv(): NodeJS.ProcessEnv {
	const e = { ...process.env };
	delete e.GIT_DIR; delete e.GIT_WORK_TREE; delete e.GIT_INDEX_FILE; delete e.GIT_COMMON_DIR; delete e.GIT_OBJECT_DIRECTORY;
	return e;
}

/** Run a git subcommand in `cwd` (best-effort; git may be absent). `-c safe.directory=*` disarms git's
 *  "dubious ownership" refusal (common on Windows for a freshly created nested repo). Returns ok +
 *  captured stderr so the caller can log WHY a commit did nothing instead of swallowing the error. */
function git(gitBin: string, cwd: string, args: string[]): { ok: boolean; err?: string } {
	try { execFileSync(gitBin, ['-c', 'safe.directory=*', ...args], { cwd, stdio: ['ignore', 'ignore', 'pipe'], env: gitEnv() }); return { ok: true }; }
	catch (e) {
		const err = e as { stderr?: Buffer; message?: string };
		return { ok: false, err: ((err.stderr && err.stderr.toString()) || err.message || 'unknown').trim().slice(0, 200) };
	}
}

/** Empty (and recreate) a directory. */
function clearDir(dir: string): void {
	try { fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true }); } catch { /* best-effort */ }
}

/** Keep only the newest child (by mtime) of a results dir, so a FINISHED loop leaves just the final
 *  run's outputs. Done ONCE at the end - never mid-loop, which would delete a file the user has open. */
function keepOnlyNewestChild(dir: string, log?: (m: string) => void): void {
	try {
		const entries = fs.readdirSync(dir, { withFileTypes: true }).filter(e => !e.name.startsWith('.'));
		if (entries.length <= 1) { return; }
		const scored = entries.map(e => { let m = 0; try { m = fs.statSync(path.join(dir, e.name)).mtimeMs; } catch { /* keep 0 */ } return { name: e.name, m }; });
		scored.sort((a, b) => b.m - a.m);
		for (const s of scored.slice(1)) { try { fs.rmSync(path.join(dir, s.name), { recursive: true, force: true }); } catch { /* best-effort */ } }
		log?.(`results pruned to final: kept ${scored[0].name}, removed ${scored.length - 1}`);
	} catch { /* best-effort */ }
}

/** Record one iteration's code as a git version: overwrite solution.<ext> in the loop's code folder
 *  and commit it (message = "iter N: pass/fail - reason"). The working tree stays the latest code; the
 *  commit history is every attempt (pass + fail), so the Files tab can show a version tree. Local repo,
 *  no remote / GitHub. Best-effort: if git is missing it just leaves solution.<ext> uncommitted. */
function commitIterationCode(gitBin: string, codeDir: string, iteration: number, code: string | undefined, codeLanguage: string | undefined, verdict: 'pass' | 'fail', detail: string, log?: (m: string) => void): void {
	try {
		fs.mkdirSync(codeDir, { recursive: true });
		const hadCode = !!(code && code.trim());
		const body = hadCode ? (code as string).trim() : '# (no code captured this iteration)';
		const file = `solution.${codeExt(codeLanguage)}`;
		fs.writeFileSync(path.join(codeDir, file), body + '\n');
		log?.(`commit iter ${iteration}: gitBin=${gitBin} codeDir=${codeDir} wrote=${file} codeCaptured=${hadCode}`);
		if (!fs.existsSync(path.join(codeDir, '.git'))) {
			const r = git(gitBin, codeDir, ['init', '-q']);
			log?.(`  git init: ${r.ok ? 'ok' : 'FAILED ' + r.err}`);
			if (!r.ok) { return; }
		}
		const ra = git(gitBin, codeDir, ['add', '-A']);
		if (!ra.ok) { log?.(`  git add: FAILED ${ra.err}`); return; }
		const reason = (detail || '').replace(/\s+/g, ' ').trim().slice(0, 100);
		const msg = `iter ${iteration}: ${verdict}${reason ? ` - ${reason}` : ''}`;
		const rc = git(gitBin, codeDir, ['-c', 'user.name=Qoka', '-c', 'user.email=loops@qoka.local', 'commit', '-q', '--allow-empty', '-m', msg]);
		log?.(`  git commit: ${rc.ok ? 'ok - ' + msg : 'FAILED ' + rc.err}`);
	} catch (e) { log?.(`commit iter ${iteration}: EXCEPTION ${(e as Error).message}`); }
}

/** Materialize the evaluator to a file and record its sha256 = the lock. Called once at
 *  the start of a run. From here the engine only ever runs THIS artifact. */
export function materializeAndLockEvaluator(run: LoopRun, loopDir: string): void {
	const p = evaluatorPath(run, loopDir);
	fs.mkdirSync(path.dirname(p), { recursive: true });
	const code = run.spec.evaluator.code;
	fs.writeFileSync(p, code);
	const hash = sha256(code);
	run.lockedEvaluatorRef = { path: p, hash };
	run.spec.evaluator.hash = hash;
}

/** Run the locked evaluator via the injected runner and return a deterministic verdict. The
 *  SOURCE OF TRUTH is `run.spec.evaluator.code` (locked in engine state at approval - the
 *  sub-agent has no access to it), so there is nothing on disk for the sub-agent to tamper
 *  with. Executes WHERE the work happened (the ScriptRunner runs in the run environment).
 *  Verdict protocol: a JSON {"pass": bool, "detail": string} on stdout wins; else exit 0 = pass. */
export async function runLockedEvaluator(run: LoopRun, runner: ScriptRunner): Promise<Verdict> {
	const code = run.spec.evaluator.code;
	if (!code) { return { pass: false, detail: 'no locked evaluator' }; }
	let r: { stdout: string; stderr: string; exitCode: number | null };
	try {
		r = await runner(code, run.spec.evaluator.language);
	} catch (e) {
		return { pass: false, detail: `evaluator failed to run: ${(e as Error).message}` };
	}
	const m = r.stdout.match(/\{[\s\S]*?"pass"[\s\S]*?\}/);
	if (m) {
		try {
			const j = JSON.parse(m[0]) as { pass?: unknown; detail?: unknown };
			return { pass: j.pass === true, detail: String(j.detail ?? '') };
		} catch { /* fall through to exit code */ }
	}
	return { pass: r.exitCode === 0, detail: (r.stderr || r.stdout).trim().slice(0, 500) };
}

/** Strip the volatile parts of an error (numbers, hex, paths, whitespace) so two runs of
 *  the "same" failure compare equal. Used for no-progress detection. */
export function normalizeSignature(s: string): string {
	return s
		.replace(/0x[0-9a-fA-F]+/g, '#')
		.replace(/\/[^\s:'"]+/g, '/PATH')
		.replace(/\d+/g, '#')
		.replace(/\s+/g, ' ')
		.trim()
		.slice(0, 200);
}

/** No progress = the last NO_PROGRESS_N failures share one normalized signature. */
export function noProgress(run: LoopRun): boolean {
	const sigs = run.history.map(h => h.errorSignature).filter((s): s is string => !!s);
	if (sigs.length < NO_PROGRESS_N) { return false; }
	const last = sigs.slice(-NO_PROGRESS_N);
	return last.every(s => s === last[0]);
}

/**
 * The control loop. Deterministic: the engine decides iterate/stop/pause; the injected
 * agentStep does the work; the locked evaluator judges. Persists after every iteration so
 * a restart can resume.
 */
export async function runLoop(run: LoopRun, agentStep: AgentStep, opts: RunOptions): Promise<LoopOutcome> {
	materializeAndLockEvaluator(run, opts.loopDir);
	run.status = 'running';
	run.reason = undefined;
	run.budget.startedAt = new Date().toISOString();
	opts.persist(run);

	const startMs = Date.now();
	let feedback: string | undefined;
	opts.log?.(`runLoop start: id=${run.id} gitPath=${opts.gitPath || 'git'} codeDir=${opts.codeDir || '(none)'} resultsDir=${opts.resultsDir || '(none)'}`);

	// Clear stale outputs ONCE, only on a fresh start (not on resume). We deliberately do NOT clear
	// results between iterations - that would delete a file the user has opened to inspect. Instead the
	// results are pruned to the final run at the very end (keepOnlyNewestChild).
	if (opts.resultsDir && run.iteration === 0) { clearDir(opts.resultsDir); }
	const prune = (): void => { if (opts.resultsDir) { keepOnlyNewestChild(opts.resultsDir, opts.log); } };

	while (run.iteration < run.budget.maxIter && (Date.now() - startMs) < run.budget.maxMin * 60_000) {
		if (opts.shouldStop?.()) {
			run.status = 'stopped';
			run.reason = 'stopped by user';
			opts.persist(run);
			return 'stopped';
		}
		const iterStart = Date.now();
		const r = await agentStep(run, feedback);
		if (typeof r.tokens === 'number') { run.budget.usedTokens += r.tokens; }
		if (r.envError) {
			run.status = 'paused';
			run.reason = r.error ?? 'environment error';
			opts.persist(run);
			return 'paused';
		}

		const verdict = await runLockedEvaluator(run, opts.evaluatorRunner);
		const entry: LoopHistoryEntry = {
			iteration: run.iteration,
			verdict: verdict.pass ? 'pass' : 'fail',
			detail: verdict.detail,
			errorSignature: verdict.pass ? undefined : normalizeSignature(verdict.detail),
			at: new Date().toISOString(),
			durationMs: Date.now() - iterStart,
		};
		// Commit THIS iteration's code as a git version (message carries the verdict + reason), so the
		// Files tab can show a version tree and the failed attempts are recoverable.
		if (opts.codeDir) { commitIterationCode(opts.gitPath || 'git', opts.codeDir, run.iteration, r.code, r.codeLanguage, verdict.pass ? 'pass' : 'fail', verdict.detail, opts.log); }
		run.history.push(entry);
		run.iteration++;
		opts.persist(run);

		if (verdict.pass) {
			run.status = 'success';
			opts.persist(run);
			prune();
			return 'success';
		}
		if (noProgress(run)) {
			run.status = 'failed';
			run.reason = 'no progress (same failure repeated)';
			opts.persist(run);
			prune();
			return 'failed-structural';
		}
		feedback = verdict.detail;
	}

	prune();
	run.status = 'failed';
	run.reason = 'budget exhausted';
	opts.persist(run);
	return 'failed-budget';
}
