/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Qoka's routing rules for Codex, written into ~/.codex/AGENTS.md.
 *
 * Why AGENTS.md and not the MCP `instructions` field or a skill: Codex reads
 * AGENTS.md as BASE instructions every session, unconditionally. The MCP
 * `initialize` instructions field appears not to be injected by Codex, and a
 * skill's body only loads when its description keyword-matches the task - so
 * neither is guaranteed. AGENTS.md is the one channel Codex always reads, which
 * is what makes it the right home for "always prefer Qoka's MCP tools".
 *
 * The block is delimited by markers so we only ever rewrite OUR section and
 * leave anything the user wrote in the same file untouched.
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const CODEX_AGENTS_PATH = path.join(os.homedir(), '.codex', 'AGENTS.md');
const BEGIN_MARKER = '<!-- QOKA:BEGIN - managed by Qoka; edits inside this block are overwritten -->';
const END_MARKER = '<!-- QOKA:END -->';

/** The managed block. Kept compact - it is base context on EVERY Codex turn. */
const QOKA_BLOCK = [
	BEGIN_MARKER,
	'# Qoka workspace rules',
	'',
	'You are running inside **Qoka**, a research workbench that ships dedicated MCP tools. For anything that',
	'happens inside Qoka, PREFER the matching Qoka MCP tool over your own generic capability or your own shell.',
	'',
	'## Running or checking code',
	'',
	'- To RUN / EXECUTE code, or to CHECK whether a package or tool is installed: call `get_workspace_info`',
	'  (qoka-autopipe MCP) first to confirm the active run connection, then `run_code` (qoka-run MCP) for a quick',
	'  script, or `execute_pipeline` (qoka-autopipe MCP) for a reproducible pipeline.',
	'- NEVER use your own terminal / shell / python for this. `python -c`, `pip show`, `pip list`, `conda list`',
	'  or `which` in your own shell inspect the WRONG machine - not the Qoka run environment - so the answer is',
	'  misleading. To check a package, run a tiny import script through `run_code`.',
	'- If you already ran something in your own shell and it failed, STOP and redo it through `run_code`.',
	'',
	'## Which tool for which task',
	'',
	'- Write / revise / peer-review a paper -> the paper MCP tools (e.g. `propose_manuscript_revision`); for AI',
	'  peer review use the `iterative-paper-defense` skill.',
	'- FIND / look up literature -> the `paper-lookup` skill. There is no paper-search MCP, and you must not use',
	'  your own web search for literature.',
	'- SAVE a paper to the library / list saved papers -> `save_paper` / `list_saved_papers` (qoka-paper-library MCP).',
	'- Plan a project / build a roadmap -> the roadmap MCP tools.',
	'- Take or organise research notes -> the notes MCP tools.',
	'- Search methods or hypotheses -> the `qoka-methods-search` / `qoka-hypothesis` MCP tools.',
	'- Project title / summary / to-do list -> the Project Overview MCP tools.',
	'- Recall earlier project context -> the memory MCP tools.',
	'',
	'## Show the tab you are working in',
	'',
	'When you start a task that belongs to a Qoka tab, OPEN that tab first so the user can see what is',
	'happening: Project Overview -> `open_overview`, Roadmap -> `open_roadmap`, Peer review -> `open_new_review`.',
	'For papers, notes and autopipe, calling that MCP\'s own action tool (`create_paper` / `save_paper` /',
	'`create_note` / `execute_pipeline`) surfaces its tab as it runs. Do not work silently in the background',
	'when a tab exists for the task.',
	'',
	'## Starting a new project or analysis',
	'',
	'The user\'s FIRST message in an empty project usually describes what they want to work on. Do not hijack it,',
	'and do not ignore it - decide by the kind of message:',
	'',
	'- It describes a PROJECT or research direction -> ASK ONCE, in one short question, which they want, then',
	'  follow their answer: "이 내용으로 프로젝트 개요(제목/설명)를 먼저 정리할까요, 아니면 바로 <the task they',
	'  named>을 진행할까요?" If they pick the task, do it and offer the overview again afterwards.',
	'- It is a clearly ONE-OFF action ("run this code", "find papers on X", "save this paper") -> just DO it.',
	'  Do not ask about the overview first; offer it only afterwards.',
	'',
	'Ask at most once. When the user has chosen the overview, tell them the plan up front and follow it IN ORDER:',
	'',
	'1. Ask a few focused questions, then write the Overview: `set_project_title` + `update_project_summary`',
	'   (open it with `open_overview`).',
	'2. `open_roadmap` and build the plan with `propose_node` (the user accepts or rejects each).',
	'3. When the roadmap looks complete, create the to-dos with `add_tasks`, THEN `open_overview` to show the',
	'   roadmap and the list together.',
	'4. Ask the user to confirm. As work proceeds keep tasks current with `propose_task_completion` and, only',
	'   after the user agrees, `set_task_done`.',
	END_MARKER,
].join('\n');

/**
 * Create or refresh Qoka's block in ~/.codex/AGENTS.md. Only runs when the Codex
 * extension is installed, so we never create a stray ~/.codex for Claude-only
 * users. Idempotent and best-effort: a failure here must never block activation.
 */
export function ensureCodexAgentsMd(): void {
	if (!vscode.extensions.getExtension('openai.chatgpt')) {
		return;
	}
	try {
		let existing = '';
		try {
			existing = fs.readFileSync(CODEX_AGENTS_PATH, 'utf8');
		} catch {
			// No file yet - we'll create one containing just our block.
		}

		const start = existing.indexOf(BEGIN_MARKER);
		const end = existing.indexOf(END_MARKER);
		let next: string;
		if (start !== -1 && end !== -1 && end > start) {
			// Replace only our block, keeping whatever the user wrote around it.
			next = existing.slice(0, start) + QOKA_BLOCK + existing.slice(end + END_MARKER.length);
		} else if (existing.trim()) {
			// User has their own AGENTS.md - append ours after it.
			next = `${existing.replace(/\s*$/, '')}\n\n${QOKA_BLOCK}\n`;
		} else {
			next = `${QOKA_BLOCK}\n`;
		}

		if (next === existing) {
			return;
		}
		fs.mkdirSync(path.dirname(CODEX_AGENTS_PATH), { recursive: true });
		const tmp = `${CODEX_AGENTS_PATH}.tmp`;
		fs.writeFileSync(tmp, next);
		fs.renameSync(tmp, CODEX_AGENTS_PATH);
		console.log('[aria-skills] refreshed Qoka rules in ~/.codex/AGENTS.md');
	} catch (e) {
		console.warn(`[aria-skills] could not update ~/.codex/AGENTS.md: ${(e as Error).message}`);
	}
}
