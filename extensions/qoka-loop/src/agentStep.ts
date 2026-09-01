/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The real agent_step (M1b): assemble the per-iteration prompt (loop_engine_design.md
// section 12) and run one headless sub-agent turn wired to run_code. buildPrompt is a pure
// function so it can be unit-tested; makeAgentStep binds it to the run environment.

import * as path from 'path';
import { LoopRun } from './schema';
import { AgentResult, AgentStep } from './engine';
import { Provider, runAgent, writeMcpConfig, setupCodexHome } from './headlessRun';

/** One-line summary of the recent iteration history (kept short; full state is on disk). */
function historyDigest(run: LoopRun, max = 6): string {
	const recent = run.history.slice(-max);
	if (recent.length === 0) { return '(none yet)'; }
	return recent.map(h => `  iter ${h.iteration}: ${h.verdict}${h.detail ? ` - ${h.detail}` : ''}`).join('\n');
}

/**
 * Assemble the sub-agent prompt. PINNED (never trimmed): the work directive + goal + the
 * LOCKED evaluator (shown read-only so the agent knows what "done" means but cannot game it).
 * VARIABLE: the iteration history digest + the last failure feedback.
 */
export function buildPrompt(run: LoopRun, feedback: string | undefined): string {
	const spec = run.spec;
	const evaluator = spec.evaluator.code;
	return [
		'You are one iteration of an automated research loop. Do the work for THIS turn toward the goal,',
		'then stop. A separate, LOCKED evaluator (shown below) decides pass/fail after you finish - you',
		'cannot see its result and MUST NOT modify or recreate it; just make your work satisfy it.',
		'',
		`GOAL: ${spec.goal}`,
		'',
		'DO:',
		' - Use the run_code tool to write and run your code in this project (create/edit files as needed).',
		' - Make the actual output the evaluator checks (e.g. the file/metric it reads).',
		' - Keep changes minimal and focused; do not fabricate results.',
		'',
		'LOCKED EVALUATOR (read-only - the engine runs exactly this after your turn):',
		'```',
		evaluator,
		'```',
		'',
		feedback ? `LAST EVALUATOR FEEDBACK (fix this): ${feedback}` : 'This is the first attempt.',
		'',
		'RECENT ITERATIONS:',
		historyDigest(run),
	].join('\n');
}

export interface AgentStepOptions {
	provider: Provider;
	/** Working directory for the sub-agent + evaluator (the project root). */
	cwd: string;
	/** <project>/.qoka/loops - where the per-loop mcp-config is written. */
	loopDir: string;
	/**
	 * The WORK MCP servers to give the sub-agent, name -> { SSE url (Claude) + port (Codex /mcp) }.
	 * This is the same toolset the main chat has (run_code, autopipe, paper, notes, ...) MINUS the
	 * loop-control server, so a loop can drive any Qoka tool - not just run_code - while a sub-agent
	 * can never start another loop (no recursion). Claude gets them via --strict-mcp-config; Codex
	 * via a per-loop CODEX_HOME. Empty means no MCP tools.
	 */
	workMcpServers: Record<string, { url: string; port: number }>;
	/** Readable per-loop folder name (slug-id); run_code groups this loop's runs under
	 *  results/loops/<loopFolder>/ + analysis/loops/<loopFolder>/ instead of the project root. */
	loopFolder: string;
	/** Aborted when the user stops the loop, so a running sub-agent turn is killed promptly. */
	signal?: AbortSignal;
}

/** Bind buildPrompt + runAgent into an AgentStep the engine can call each iteration. */
export function makeAgentStep(opts: AgentStepOptions): AgentStep {
	const hasServers = Object.keys(opts.workMcpServers).length > 0;
	// Codex has no per-invocation MCP flag, so build its per-loop CODEX_HOME once here (config.toml
	// listing the curated servers over Codex's /mcp transport). Its run_code scope is loop-level
	// (loops/<loopFolder>) since the codex home is built once, not per iteration. Claude instead gets
	// a per-iteration --mcp-config file with a per-iteration scope (loops/<loopFolder>/iter-<n>).
	const codexHome = (hasServers && opts.provider === 'codex')
		? setupCodexHome(path.join(opts.loopDir, '_codex-home'), opts.workMcpServers, `loops/${opts.loopFolder}`)
		: undefined;
	return async (run: LoopRun, feedback: string | undefined): Promise<AgentResult> => {
		const prompt = buildPrompt(run, feedback);
		let mcpConfigPath: string | undefined;
		if (hasServers && opts.provider === 'claude') {
			mcpConfigPath = path.join(opts.loopDir, run.id, 'mcp-config.json');
			writeMcpConfig(mcpConfigPath, opts.workMcpServers, `loops/${opts.loopFolder}`);
		}
		const r = await runAgent(opts.provider, prompt, { cwd: opts.cwd, mcpConfigPath, codexHome, signal: opts.signal });
		return { output: r.output, exitCode: r.exitCode, envError: r.envError, error: r.error, code: r.code, codeLanguage: r.codeLanguage, tokens: r.tokens };
	};
}
