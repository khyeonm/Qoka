/* Headless self-test for the deterministic engine (no vscode, no app). Bundle with
 * esbuild and run with node: validates success / no-progress / budget / evaluator-lock.
 * The evaluatorRunner is injected (a LOCAL runner here; the extension injects a run-env one). */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';
import { LoopRun, LoopSpec } from './schema';
import { runLoop, runLockedEvaluator, materializeAndLockEvaluator, AgentStep, ScriptRunner } from './engine';

let failures = 0;
function assert(cond: boolean, msg: string): void {
	if (cond) { console.log(`  ok  - ${msg}`); }
	else { console.error(`  FAIL - ${msg}`); failures++; }
}

// A python evaluator that passes only when <cwd>/answer.txt contains exactly "42".
const ANSWER_EVALUATOR = `import os, json
p = os.path.join(os.getcwd(), 'answer.txt')
v = open(p).read().strip() if os.path.exists(p) else ''
print(json.dumps({"pass": v == "42", "detail": "got %r" % v}))`;

/** A ScriptRunner that runs the evaluator LOCALLY in cwd (stands in for the run-env runner). */
function localRunner(cwd: string): ScriptRunner {
	return (script, language) => new Promise((resolve) => {
		const cmd = language === 'python' ? 'python3' : language === 'node' ? 'node' : 'bash';
		const f = path.join(cwd, `.eval-${Math.random().toString(16).slice(2)}.tmp`);
		fs.writeFileSync(f, script);
		let out = '';
		let err = '';
		const proc = spawn(cmd, [f], { cwd });
		proc.stdout.on('data', d => { out += d; });
		proc.stderr.on('data', d => { err += d; });
		proc.on('error', e => resolve({ stdout: '', stderr: String(e), exitCode: null }));
		proc.on('close', code => { try { fs.unlinkSync(f); } catch { /* ignore */ } resolve({ stdout: out, stderr: err, exitCode: code }); });
	});
}

function makeRun(evaluatorCode: string, maxIter = 15): LoopRun {
	const spec: LoopSpec = {
		title: 'test', goal: 'answer.txt == 42',
		flow: { steps: ['write answer'], checks: [{ c: 'answer==42', why: 'objective' }] },
		evaluator: { code: evaluatorCode, language: 'python' },
		budget: { maxIter, maxMin: 5 },
	};
	const now = new Date().toISOString();
	return {
		id: 'test' + Math.random().toString(16).slice(2, 8), spec, status: 'pending-approval',
		iteration: 0, budget: { maxIter, maxMin: 5, usedTokens: 0 }, history: [],
		createdAt: now, updatedAt: now,
	};
}

function tmp(): { loopDir: string; cwd: string } {
	const base = fs.mkdtempSync(path.join(os.tmpdir(), 'qoka-loop-test-'));
	const loopDir = path.join(base, 'loops');
	const cwd = path.join(base, 'work');
	fs.mkdirSync(loopDir, { recursive: true });
	fs.mkdirSync(cwd, { recursive: true });
	return { loopDir, cwd };
}

async function main(): Promise<void> {
	// 1) SUCCESS: agent converges to "42" on the 3rd turn.
	{
		const { loopDir, cwd } = tmp();
		const run = makeRun(ANSWER_EVALUATOR);
		const values = ['wrong', 'aaa', '42'];
		const agent: AgentStep = async (r) => {
			fs.writeFileSync(path.join(cwd, 'answer.txt'), values[Math.min(r.iteration, values.length - 1)]);
			return { output: 'wrote', exitCode: 0 };
		};
		const outcome = await runLoop(run, agent, { loopDir, cwd, evaluatorRunner: localRunner(cwd), persist: () => { } });
		console.log('Test 1 (success):');
		assert(outcome === 'success', `outcome is success (got ${outcome})`);
		assert(run.iteration === 3, `succeeded on iteration 3 (got ${run.iteration})`);
	}

	// 2) NO-PROGRESS: agent writes the same wrong value every time -> stop at N=3.
	{
		const { loopDir, cwd } = tmp();
		const run = makeRun(ANSWER_EVALUATOR);
		const agent: AgentStep = async () => {
			fs.writeFileSync(path.join(cwd, 'answer.txt'), 'wrong');
			return { output: 'wrote', exitCode: 0 };
		};
		const outcome = await runLoop(run, agent, { loopDir, cwd, evaluatorRunner: localRunner(cwd), persist: () => { } });
		console.log('Test 2 (no-progress):');
		assert(outcome === 'failed-structural', `outcome is failed-structural (got ${outcome})`);
		assert(run.iteration === 3, `stopped at 3 identical failures (got ${run.iteration})`);
	}

	// 3) BUDGET: agent keeps changing (distinct non-numeric values) but never hits 42.
	{
		const { loopDir, cwd } = tmp();
		const run = makeRun(ANSWER_EVALUATOR, 4);
		const vals = ['aaa', 'bbb', 'ccc', 'ddd', 'eee'];
		const agent: AgentStep = async (r) => {
			fs.writeFileSync(path.join(cwd, 'answer.txt'), vals[r.iteration % vals.length]);
			return { output: 'wrote', exitCode: 0 };
		};
		const outcome = await runLoop(run, agent, { loopDir, cwd, evaluatorRunner: localRunner(cwd), persist: () => { } });
		console.log('Test 3 (budget):');
		assert(outcome === 'failed-budget', `outcome is failed-budget (got ${outcome})`);
		assert(run.iteration === 4, `stopped at maxIter=4 (got ${run.iteration})`);
	}

	// 4) EVALUATOR LOCK: the code string in engine state is the source of truth. Tampering the
	//    on-disk copy does nothing - execution uses the locked string, so no forced pass.
	{
		const { loopDir, cwd } = tmp();
		const run = makeRun(ANSWER_EVALUATOR);
		materializeAndLockEvaluator(run, loopDir);
		fs.writeFileSync(run.lockedEvaluatorRef!.path, 'import json; print(json.dumps({"pass": True, "detail": "cheat"}))');
		const verdict = await runLockedEvaluator(run, localRunner(cwd));
		console.log('Test 4 (evaluator lock):');
		assert(verdict.pass === false, 'tampered on-disk copy did NOT force a pass (locked string used)');
		assert(verdict.detail !== 'cheat', `real verdict used, not the cheat (got: ${verdict.detail})`);
	}

	console.log(failures === 0 ? '\nALL ENGINE TESTS PASSED' : `\n${failures} TEST(S) FAILED`);
	process.exit(failures === 0 ? 0 : 1);
}

void main();
