/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import {
	readOverview, setTitle, updateSummary, getSummaryText, blocksToText,
	addTask, addTasks, updateTask, removeTask, setTasksDone, proposeCompletions,
	setTaskSchedule, OverviewTask,
} from '../overview';

export interface ToolDefinition {
	name: string;
	description: string;
	inputSchema: unknown;
	handler: (args: Record<string, unknown>) => Promise<CallToolResult>;
}

export interface CallToolResult {
	content: Array<{ type: 'text'; text: string }>;
	isError?: boolean;
}

function ok(text: string): CallToolResult { return { content: [{ type: 'text', text }] }; }
function err(text: string): CallToolResult { return { content: [{ type: 'text', text }], isError: true }; }
function asString(v: unknown): string | undefined { return typeof v === 'string' ? v : undefined; }
function asStringArray(v: unknown): string[] | undefined {
	return Array.isArray(v) && v.every(x => typeof x === 'string') ? (v as string[]) : undefined;
}

/** A task as returned to the AI: identity + completion + the (optional) schedule
 *  fields, so the AI can both read a deadline and reason about it. Undefined
 *  fields are omitted to keep the JSON compact. */
function taskView(t: OverviewTask): Record<string, unknown> {
	const out: Record<string, unknown> = { id: t.id, label: t.label, done: t.done };
	if (t.checkedAt) { out.checkedAt = t.checkedAt; }
	if (t.startDate) { out.startDate = t.startDate; }
	if (t.startTime) { out.startTime = t.startTime; }
	if (t.dueDate) { out.dueDate = t.dueDate; }
	if (t.dueTime) { out.dueTime = t.dueTime; }
	return out;
}

/** 'YYYY-MM-DD' local calendar date. */
function isDate(s: string): boolean { return /^\d{4}-\d{2}-\d{2}$/.test(s); }
/** 'HH:mm' 24-hour local time. */
function isTime(s: string): boolean { return /^([01]\d|2[0-3]):[0-5]\d$/.test(s); }

/** Reveal the Project Overview tab (the same command open_overview uses), so a
 *  task the AI just checked off is visible without the user hunting for it.
 *  Best-effort - never fails the tool call. */
async function revealOverview(): Promise<void> {
	try { await vscode.commands.executeCommand('aria.overview.open'); } catch { /* tab optional */ }
}

/**
 * Project Overview tools. Read the project's title / summary / To-do list and
 * update them. The two proposal tools are the heart of progress tracking: when,
 * during a conversation, a To-do item looks finished, call propose_task_completion(s)
 * to surface an Accept/Reject badge in the Notebook tab AND then ask the
 * user in chat. Only mark a task done (set_task_done) once the user agrees.
 */
export function buildTools(): ToolDefinition[] {
	return [
		{
			name: 'get_project_overview',
			description: 'Read the whole Project Overview at once: title, summary (as plain text), and the To-do list (each task has id, label, done, and any schedule fields startDate/startTime/dueDate/dueTime/checkedAt). Use the granular get_* tools if you only need one part.',
			inputSchema: { type: 'object', properties: {}, additionalProperties: false },
			handler: async () => {
				const d = readOverview();
				return ok(JSON.stringify({
					title: d.title,
					summary: blocksToText(d.content),
					tasks: d.tasks.map(taskView),
				}));
			},
		},
		{
			name: 'get_project_title',
			description: 'Read just the project title.',
			inputSchema: { type: 'object', properties: {}, additionalProperties: false },
			handler: async () => ok(JSON.stringify({ title: readOverview().title })),
		},
		{
			name: 'get_project_summary',
			description: 'Read just the project summary (Content) as plain text.',
			inputSchema: { type: 'object', properties: {}, additionalProperties: false },
			handler: async () => ok(JSON.stringify({ summary: getSummaryText() })),
		},
		{
			name: 'get_tasks',
			description: 'Read the To-do list only. Returns each task as {id, label, done} plus any schedule fields (startDate, startTime, dueDate, dueTime as local wall-clock strings; checkedAt when completed). Call this to know the current tasks before proposing completions or reading/reasoning about deadlines.',
			inputSchema: { type: 'object', properties: {}, additionalProperties: false },
			handler: async () => ok(JSON.stringify(readOverview().tasks.map(taskView))),
		},
		{
			name: 'set_project_title',
			description: 'Set the project title. Call open_overview FIRST so the user is looking at the tab, then call this - otherwise the title lands on a closed tab and the user believes nothing happened. Once the user has chosen to do the overview, call set_project_title (a short name you derive from their message) AND update_project_summary right away, then tell the user what you wrote and ask them to confirm. Follow the MANDATORY onboarding ORDER, do not skip steps: (1) open_overview, then title + summary, (2) open_roadmap ONCE, (3) build the roadmap with the roadmap MCP tools, (4) add_tasks (an action-oriented To-do), (5) open_overview again, (6) offer an OPEN next-step choice (do not assume autopipe). For any task inside Qoka, prefer the matching Qoka MCP tool (roadmap / notes / paper / methods / autopipe / memory) over your own generic capability, unless the user explicitly asks otherwise. You may ALSO use the installed Qoka skills (domain skills such as scanpy, anndata, biopython, gget, scvi-tools) whenever a task matches one - they complement the MCP tools.',
			inputSchema: {
				type: 'object',
				properties: { title: { type: 'string', description: 'New project title.' } },
				required: ['title'],
				additionalProperties: false,
			},
			handler: async (args) => {
				const title = asString(args.title);
				if (title === undefined) { return err('title (string) is required.'); }
				setTitle(title);
				return ok('Title updated.');
			},
		},
		{
			name: 'update_project_summary',
			description: 'Set or append the project summary (the Overview Content). mode "replace" (default) overwrites; "append" adds a new paragraph. The text lands in the Notebook tab, which updates live - so call open_overview BEFORE this, or the user sees an unchanged screen while you claim to have written it. Onboarding step 1: open_overview, then write this together with set_project_title, then ask the user to confirm it reads correctly. After they confirm, the NEXT step is NOT the To-do: call open_roadmap and BUILD THE ROADMAP first (steps 2-3). Do NOT call add_tasks yet - the To-do is drafted from the roadmap, which does not exist until you build it.',
			inputSchema: {
				type: 'object',
				properties: {
					summary: { type: 'string', description: 'Summary text (Markdown).' },
					mode: { type: 'string', enum: ['replace', 'append'], description: 'replace (default) or append.' },
				},
				required: ['summary'],
				additionalProperties: false,
			},
			handler: async (args) => {
				const summary = asString(args.summary);
				if (summary === undefined) { return err('summary (string) is required.'); }
				const mode = args.mode === 'append' ? 'append' : 'replace';
				updateSummary(summary, mode);
				return ok(`Summary ${mode === 'append' ? 'appended' : 'updated'}.`);
			},
		},
		{
			name: 'add_tasks',
			description: 'Add SEVERAL tasks at once (a whole drafted To-do list). HARD PRECONDITION: the To-do is derived FROM the roadmap, so you may call this ONLY AFTER the roadmap has been built (it has committed nodes - check with the roadmap tool get_tree if unsure). NEVER call add_tasks right after writing the project summary; during onboarding the order is FIXED: overview title+summary -> build the roadmap (open_roadmap, then propose/accept nodes) -> ONLY THEN add_tasks -> open_overview again. Skipping the roadmap and jumping from the summary straight to the To-do is a bug - do not do it. Prefer ACTION-oriented items the user will actually DO (experiments, analyses, concrete steps) - they need NOT mirror the roadmap 1:1. It is MANDATORY before the final open_overview - never come back to the Overview with an empty To-do. After adding them, TELL THE USER what they can do with the list themselves: reorder items with the up/down arrows on the left of each row, and give any item a deadline or a date range (with an optional time) by clicking the calendar icon on its right. When the user tells you a date/time for a task, set it yourself with set_task_schedule; do NOT invent deadlines they did not state. PHRASE each item as something the user actually does: when the work maps to a Qoka capability (finding papers, writing a paper, taking notes, running an analysis/pipeline, managing memory), write it as that Qoka action - but KEEP the user\'s specific context as a qualifier rather than a bare generic verb (for a single-cell project prefer "write the single-cell analysis paper", not just "write a paper"; "find single-cell QC method papers", not just "find papers"). Do not hardcode fixed wording - adapt the qualifier to THIS project. For steps Qoka cannot do (wet-lab / physical experiments, e.g. running an aptamer selection), do NOT phrase them as a Qoka action; write the concrete step the USER performs at the bench.',
			inputSchema: {
				type: 'object',
				properties: { labels: { type: 'array', items: { type: 'string' }, description: 'Task labels.' } },
				required: ['labels'],
				additionalProperties: false,
			},
			handler: async (args) => {
				const labels = asStringArray(args.labels);
				if (!labels || labels.length === 0) { return err('labels (non-empty string array) is required.'); }
				const added = addTasks(labels);
				return ok(`Added ${added.length} task(s). They are editable in the Notebook tab.`);
			},
		},
		{
			name: 'open_roadmap',
			description: 'Switch the UI to the Notebook tab and open THIS project\'s roadmap canvas in the editor. A new project already has exactly one empty roadmap, so this opens that one - it does NOT create a duplicate. Pass a short `title` so the roadmap is named (instead of "Untitled roadmap") and is opened from the list. Call this after the project title/summary are confirmed, to start planning the process. Onboarding step 2 - call it ONCE, and never create a roadmap yourself (either makes a duplicate).',
			inputSchema: {
				type: 'object',
				properties: { title: { type: 'string', description: 'Short descriptive roadmap title (e.g. the research theme).' } },
				additionalProperties: false,
			},
			handler: async (args) => {
				try {
					// Reveal the Notebook tab (which now holds the roadmap list) WITHOUT
					// toggling it shut when it is already active. aria.notebook.reveal wraps
					// openViewContainer; best-effort so a missing sidebar can't stop the
					// editor from opening.
					try { await vscode.commands.executeCommand('aria.notebook.reveal'); } catch { /* sidebar optional */ }
					// A fresh project already holds one empty roadmap. ensureActive
					// returns that existing (newest) roadmap's id, only creating one
					// when the project genuinely has none - so we never make a duplicate.
					const id = await vscode.commands.executeCommand<string | undefined>('aria.roadmap.ensureActive');
					const title = asString(args.title);
					if (id && title) {
						await vscode.commands.executeCommand('aria.roadmap.rename', id, title);
					}
					// openWizard opens THIS roadmap in the editor (like the sidebar list's
					// row click). Passing `name` seeds the editor tab title.
					await vscode.commands.executeCommand('aria.roadmap.openWizard', id ? { id, name: title || undefined } : undefined);
					return ok('Opened the roadmap in the Notebook tab.');
				} catch (e) {
					return err(`Could not open the roadmap: ${(e as Error).message}`);
				}
			},
		},
		{
			name: 'open_overview',
			description: 'Switch the UI to the Notebook tab (the full-width Project Overview editor). Call this BEFORE you write anything into the overview, not after: the tab updates live, so the user watching it sees the title and summary appear. If you write while the tab is closed, the user sees nothing and your "I wrote it" reads as false. During onboarding it is called TWICE and both are required: step 1, the moment the user chooses to do the overview and BEFORE set_project_title / update_project_summary; and step 5, after add_tasks, to switch from the roadmap canvas back to the Project Overview - there, also tell them the To-do list is placed BELOW the roadmap, so they should scroll down under the roadmap to see it.',
			inputSchema: { type: 'object', properties: {}, additionalProperties: false },
			handler: async () => {
				try {
					await vscode.commands.executeCommand('aria.overview.open');
					return ok('Opened the Notebook tab.');
				} catch (e) {
					return err(`Could not open the overview: ${(e as Error).message}`);
				}
			},
		},
		{
			name: 'add_task',
			description: 'Add ONE task to the To-do list. Returns the new task id.',
			inputSchema: {
				type: 'object',
				properties: { label: { type: 'string', description: 'What the task is.' } },
				required: ['label'],
				additionalProperties: false,
			},
			handler: async (args) => {
				const label = asString(args.label);
				if (!label) { return err('label (non-empty string) is required.'); }
				const task = addTask(label);
				return ok(JSON.stringify({ id: task.id, label: task.label }));
			},
		},
		{
			name: 'update_task',
			description: 'Rename a task by id.',
			inputSchema: {
				type: 'object',
				properties: {
					id: { type: 'string', description: 'Task id (from get_tasks).' },
					label: { type: 'string', description: 'New label.' },
				},
				required: ['id', 'label'],
				additionalProperties: false,
			},
			handler: async (args) => {
				const id = asString(args.id); const label = asString(args.label);
				if (!id || label === undefined) { return err('id and label are required.'); }
				return updateTask(id, { label }) ? ok('Task updated.') : err(`No task with id ${id}.`);
			},
		},
		{
			name: 'set_task_schedule',
			description: 'Set (or clear) a task\'s deadline or period. Set this when the user gives a date/time for a task ("finish X by Friday 6pm", "work on Y from Mon 9:00 to Wed 18:00"). Do NOT invent deadlines the user did not state. A SINGLE deadline uses dueDate (+ optional dueTime); a PERIOD sets startDate (+ optional startTime) through dueDate (+ optional dueTime) - a range can carry two times, one for the start and one for the end. Dates are local wall-clock (no timezone): dueDate/startDate as YYYY-MM-DD, dueTime/startTime as HH:mm (24-hour). Pass clear:true to remove all date/time from the task. Only the fields you pass are changed. The Project Overview calendar updates live.',
			inputSchema: {
				type: 'object',
				properties: {
					id: { type: 'string', description: 'Task id (from get_tasks).' },
					startDate: { type: 'string', description: 'Period start date, YYYY-MM-DD (omit for a single deadline).' },
					startTime: { type: 'string', description: 'Period start time, HH:mm 24-hour (optional).' },
					dueDate: { type: 'string', description: 'Deadline / period end date, YYYY-MM-DD.' },
					dueTime: { type: 'string', description: 'Deadline / period end time, HH:mm 24-hour (optional).' },
					clear: { type: 'boolean', description: 'true removes all date/time from the task.' },
				},
				required: ['id'],
				additionalProperties: false,
			},
			handler: async (args) => {
				const id = asString(args.id);
				if (!id) { return err('id is required.'); }
				if (args.clear === true) {
					return setTaskSchedule(id, null) ? ok('Schedule cleared.') : err(`No task with id ${id}.`);
				}
				const schedule: { startDate?: string; startTime?: string; dueDate?: string; dueTime?: string } = {};
				for (const key of ['startDate', 'dueDate'] as const) {
					const v = asString(args[key]);
					if (v !== undefined) {
						if (!isDate(v)) { return err(`${key} must be YYYY-MM-DD.`); }
						schedule[key] = v;
					}
				}
				for (const key of ['startTime', 'dueTime'] as const) {
					const v = asString(args[key]);
					if (v !== undefined) {
						if (!isTime(v)) { return err(`${key} must be HH:mm (24-hour).`); }
						schedule[key] = v;
					}
				}
				if (Object.keys(schedule).length === 0) {
					return err('Provide at least one of startDate/startTime/dueDate/dueTime, or clear:true.');
				}
				return setTaskSchedule(id, schedule) ? ok('Schedule set.') : err(`No task with id ${id}.`);
			},
		},
		{
			name: 'remove_task',
			description: 'Delete a task by id.',
			inputSchema: {
				type: 'object',
				properties: { id: { type: 'string', description: 'Task id.' } },
				required: ['id'],
				additionalProperties: false,
			},
			handler: async (args) => {
				const id = asString(args.id);
				if (!id) { return err('id is required.'); }
				return removeTask(id) ? ok('Task removed.') : err(`No task with id ${id}.`);
			},
		},
		{
			name: 'set_task_done',
			description: 'Check or uncheck ONE task. Only call after the user agreed in chat to mark it complete. `done` defaults to true. Checking a task opens the Project Overview tab so the user sees it checked - no tab Accept badge is needed.',
			inputSchema: {
				type: 'object',
				properties: {
					id: { type: 'string', description: 'Task id.' },
					done: { type: 'boolean', description: 'true = complete (default), false = reopen.' },
				},
				required: ['id'],
				additionalProperties: false,
			},
			handler: async (args) => {
				const id = asString(args.id);
				if (!id) { return err('id is required.'); }
				const done = args.done === false ? false : true;
				const r = setTasksDone([id], done, new Date().toISOString());
				if (r.updated.length) { await revealOverview(); }
				return r.updated.length ? ok(`Task marked ${done ? 'done' : 'not done'}.`) : err(`No task with id ${id}.`);
			},
		},
		{
			name: 'set_tasks_done',
			description: 'Check or uncheck SEVERAL tasks at once (after the user agreed to a batch). `done` defaults to true.',
			inputSchema: {
				type: 'object',
				properties: {
					ids: { type: 'array', items: { type: 'string' }, description: 'Task ids.' },
					done: { type: 'boolean', description: 'true = complete (default), false = reopen.' },
				},
				required: ['ids'],
				additionalProperties: false,
			},
			handler: async (args) => {
				const ids = asStringArray(args.ids);
				if (!ids || ids.length === 0) { return err('ids (non-empty string array) is required.'); }
				const done = args.done === false ? false : true;
				const r = setTasksDone(ids, done, new Date().toISOString());
				if (r.updated.length) { await revealOverview(); }
				return ok(`Marked ${r.updated.length} task(s) ${done ? 'done' : 'not done'}.`);
			},
		},
		{
			name: 'propose_task_completion',
			description: 'Propose marking ONE task complete: shows an Accept/Reject badge in the Notebook tab. Call this when a task looks finished, THEN ask the user in chat (in their own language) to confirm marking that task done. Do NOT mark it done yourself - wait for the user (they Accept in the tab or say yes, then you call set_task_done).',
			inputSchema: {
				type: 'object',
				properties: {
					id: { type: 'string', description: 'Task id.' },
					reason: { type: 'string', description: 'Short evidence for why it looks done (shown on hover).' },
				},
				required: ['id'],
				additionalProperties: false,
			},
			handler: async (args) => {
				const id = asString(args.id);
				if (!id) { return err('id is required.'); }
				const r = proposeCompletions([id], asString(args.reason));
				return r.proposed.length ? ok('Proposed. A badge is shown in the Notebook tab; ask the user to confirm.') : ok('Not proposed (task unknown, already done, or already pending).');
			},
		},
		{
			name: 'propose_task_completions',
			description: 'Propose marking SEVERAL tasks complete at once (when multiple wrapped up together). Shows Accept/Reject badges in the tab. Then ask the user in chat, allowing partial acceptance. Do NOT mark them done yourself.',
			inputSchema: {
				type: 'object',
				properties: {
					ids: { type: 'array', items: { type: 'string' }, description: 'Task ids that look finished.' },
					reason: { type: 'string', description: 'Short shared evidence.' },
				},
				required: ['ids'],
				additionalProperties: false,
			},
			handler: async (args) => {
				const ids = asStringArray(args.ids);
				if (!ids || ids.length === 0) { return err('ids (non-empty string array) is required.'); }
				const r = proposeCompletions(ids, asString(args.reason));
				return ok(`Proposed ${r.proposed.length} task(s). Badges are shown in the Notebook tab; ask the user to confirm (partial ok).`);
			},
		},
	];
}
