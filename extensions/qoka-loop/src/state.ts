/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Disk persistence for loops. One loop = one JSON file at
// <project>/.qoka/loops/<id>.json, so a session/app restart can resume (M1) and the
// prompt never has to carry every loop (loop_engine_design.md section 12). The `.qoka`
// folder is hidden, so these files never clutter the user's Analysis tree.

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import * as vscode from 'vscode';
import { LoopRun, LoopSpec, LoopStatus, LoopBudget } from './schema';

const DEFAULT_BUDGET: LoopBudget = { maxIter: 15, maxMin: 20 };

function projectRoot(): string | undefined {
	return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

/** <project>/.qoka/loops - undefined when no folder is open. */
export function loopsDir(): string | undefined {
	const root = projectRoot();
	return root ? path.join(root, '.qoka', 'loops') : undefined;
}

function ensureDir(dir: string): void {
	fs.mkdirSync(dir, { recursive: true });
}

export function newLoopId(): string {
	return crypto.randomBytes(6).toString('hex');
}

/** Persist a freshly designed LoopSpec as a pending-approval run. Returns the run,
 *  or undefined when there is no open project to write into. */
export function saveLoop(spec: LoopSpec, status: LoopStatus = 'pending-approval'): LoopRun | undefined {
	const dir = loopsDir();
	if (!dir) {
		return undefined;
	}
	ensureDir(dir);
	const now = new Date().toISOString();
	const budget = spec.budget ?? DEFAULT_BUDGET;
	const run: LoopRun = {
		id: newLoopId(),
		spec,
		status,
		iteration: 0,
		budget: { maxIter: budget.maxIter, maxMin: budget.maxMin, usedTokens: 0 },
		history: [],
		provider: spec.provider,
		createdAt: now,
		updatedAt: now,
	};
	writeLoop(run);
	return run;
}

export function writeLoop(run: LoopRun): void {
	const dir = loopsDir();
	if (!dir) {
		return;
	}
	ensureDir(dir);
	run.updatedAt = new Date().toISOString();
	const tmp = path.join(dir, `.${run.id}.json.tmp`);
	const dest = path.join(dir, `${run.id}.json`);
	fs.writeFileSync(tmp, JSON.stringify(run, null, 2));
	fs.renameSync(tmp, dest);
}

export function readLoop(id: string): LoopRun | undefined {
	const dir = loopsDir();
	if (!dir) {
		return undefined;
	}
	try {
		return JSON.parse(fs.readFileSync(path.join(dir, `${id}.json`), 'utf8')) as LoopRun;
	} catch {
		return undefined;
	}
}

export function listLoops(): LoopRun[] {
	const dir = loopsDir();
	if (!dir) {
		return [];
	}
	let files: string[];
	try {
		files = fs.readdirSync(dir).filter(f => f.endsWith('.json') && !f.startsWith('.'));
	} catch {
		return [];
	}
	const runs: LoopRun[] = [];
	for (const f of files) {
		try {
			runs.push(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as LoopRun);
		} catch {
			// skip a corrupt file rather than failing the whole list
		}
	}
	return runs.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}
