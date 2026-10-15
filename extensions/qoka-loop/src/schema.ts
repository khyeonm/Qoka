/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Data model for the Research Loop Engine. See loop_engine_design.md section 13.
// A LoopSpec is what design_loop produces (display summary + executable evaluator);
// a LoopRun is the runtime record persisted under <project>/.qoka/loops/<id>.json.

export type Provider = 'claude' | 'codex';

/** One evaluator check, shown to the user as "passes only if ..." with the reason. */
export interface LoopCheck {
	/** The condition, e.g. "CD8A & GZMB q<0.05". */
	c: string;
	/** Why this check makes the loop trustworthy (a negative control, etc.). */
	why: string;
}

/** Display-only summary of the loop (drives the picture and the walkthrough). */
export interface LoopFlow {
	input?: string;
	steps: string[];
	checks: LoopCheck[];
	output?: string;
	stops?: string;
}

/** The executable evaluator: the truth source. `code` is materialized to a file and
 *  sha256-locked at start (M1). The verdict protocol is a deterministic exit code
 *  (0 = pass, non-zero = fail) or a JSON `{ pass, detail }` on stdout. */
export interface LoopEvaluator {
	/** Executable check source (e.g. a Python or shell script). */
	code: string;
	/** Interpreter hint: 'python' | 'sh' | 'node' | ... (defaults to shell). */
	language?: string;
	/** sha256 of the locked artifact, set when start_loop materializes it (M1). */
	hash?: string;
}

export interface LoopBudget {
	/** Hard stop after this many iterations (default 15). */
	maxIter: number;
	/** Hard stop after this many minutes (default 20). */
	maxMin: number;
}

/** design_loop's output: goal + display summary + executable evaluator (+ chain). */
export interface LoopSpec {
	title: string;
	goal: string;
	flow: LoopFlow;
	evaluator: LoopEvaluator;
	budget?: LoopBudget;
	/** Present only for a chain (a big goal split into shorter loops). */
	subLoops?: LoopSpec[];
	provider?: Provider;
}

export type LoopStatus =
	| 'pending-approval'
	| 'running'
	| 'paused'
	| 'success'
	| 'failed'
	| 'stopped';

/** One iteration's record kept in the run history (kept small; big output stays on disk). */
export interface LoopHistoryEntry {
	iteration: number;
	verdict?: 'pass' | 'fail';
	detail?: string;
	/** Normalized error signature for no-progress detection (M1). */
	errorSignature?: string;
	at: string;
	/** Wall-clock time this iteration took (sub-agent turn + evaluator), in milliseconds. */
	durationMs?: number;
}

/** A no-change pause: which iterations repeated which failure, plus a readable history report. */
export interface LoopStall {
	at: string;
	fromIteration: number;
	toIteration: number;
	/** The failure that repeated (the evaluator's one-line detail). */
	detail: string;
	/** Multi-line report: recent iterations, budget used, where the code versions are, and the options. */
	report: string;
}

/** Runtime record persisted at <project>/.qoka/loops/<id>.json. */
export interface LoopRun {
	id: string;
	spec: LoopSpec;
	status: LoopStatus;
	iteration: number;
	/** `usedMs` is the wall-clock time spent across ALL sessions (start + every resume), so maxMin is a
	 *  total budget rather than restarting at each resume. */
	budget: LoopBudget & { usedTokens: number; startedAt?: string; usedMs?: number };
	history: LoopHistoryEntry[];
	provider?: Provider;
	createdAt: string;
	updatedAt: string;
	/** Per-loop code folder (relative to project root), e.g. `.qoka/loops/<id>/files`. */
	rootDir?: string;
	/** The locked evaluator artifact (path + sha256), set at start (M1). */
	lockedEvaluatorRef?: { path: string; hash: string };
	/** Why the run is paused/failed, surfaced in the UI. */
	reason?: string;
	/** Set when the engine paused because the same failure repeated (no change). The report is the
	 *  iteration history laid out for the user to judge whether the loop is still improving; the chat
	 *  reads it via loop_status and asks the user to continue, stop, or redesign. */
	stall?: LoopStall;
	/** History index from which no-change detection counts again (set when a stalled loop is resumed,
	 *  so the same three failures do not re-trigger the pause immediately). */
	noProgressFrom?: number;
	/** The fix-this feedback for the next iteration, persisted so a paused/stopped loop resumes with it. */
	lastFeedback?: string;
	/** Live within-iteration progress, from the sub-agent's mandatory [QOKA_STEP k/N] markers: which
	 *  planned step (1-based k of n) is currently running, its label, and a stdout tail. Set while a turn
	 *  runs, cleared when the loop is not running. Drives the Progress bar in the detail tab. */
	liveStep?: { k: number; n: number; label: string; out?: string; at: string };
}
