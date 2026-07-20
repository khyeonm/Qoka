/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import {
	readOverview, setTitle, updateSummary, getSummaryText, blocksToText,
	addTask, addTasks, updateTask, removeTask, setTasksDone, proposeCompletions,
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

/**
 * Project Overview tools. Read the project's title / summary / To-do list and
 * update them. The two proposal tools are the heart of progress tracking: when,
 * during a conversation, a To-do item looks finished, call propose_task_completion(s)
 * to surface an Accept/Reject badge in the Project Overview tab AND then ask the
 * user in chat. Only mark a task done (set_task_done) once the user agrees.
 */
export function buildTools(): ToolDefinition[] {
	return [
		{
			name: 'get_project_overview',
			description: 'Read the whole Project Overview at once: title, summary (as plain text), and the To-do list (each task has id, label, done). Use the granular get_* tools if you only need one part.',
			inputSchema: { type: 'object', properties: {}, additionalProperties: false },
			handler: async () => {
				const d = readOverview();
				return ok(JSON.stringify({
					title: d.title,
					summary: blocksToText(d.content),
					tasks: d.tasks.map(t => ({ id: t.id, label: t.label, done: t.done })),
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
			description: 'Read the To-do list only. Returns each task as {id, label, done}. Call this to know the current tasks before proposing completions.',
			inputSchema: { type: 'object', properties: {}, additionalProperties: false },
			handler: async () => ok(JSON.stringify(readOverview().tasks.map(t => ({ id: t.id, label: t.label, done: t.done })))),
		},
		{
			name: 'set_project_title',
			description: 'Set the project title. This is the FIRST action for a new/empty project: the user\'s first message describing what they want to work on IS the onboarding answer, so IMMEDIATELY call set_project_title (a short name you derive) AND update_project_summary, then tell the user what you wrote and ask them to confirm. Then follow the MANDATORY onboarding ORDER, do not skip steps: (1) title + summary, (2) open_roadmap ONCE, (3) build the roadmap with the roadmap MCP tools, (4) add_tasks (an action-oriented To-do), (5) open_overview, (6) offer an OPEN next-step choice (do not assume autopipe). For any task inside Qoka, prefer the matching Qoka MCP tool (roadmap / notes / paper / methods / autopipe / memory) over your own generic capability, unless the user explicitly asks otherwise. You may ALSO use the installed Qoka skills (domain skills such as scanpy, anndata, biopython, gget, scvi-tools) whenever a task matches one - they complement the MCP tools.',
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
			description: 'Set or append the project summary (the Overview Content). mode "replace" (default) overwrites; "append" adds a new paragraph. Onboarding step 1: write this together with set_project_title as your FIRST action for a new project, then ask the user to confirm it reads correctly.',
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
			description: 'Add SEVERAL tasks at once (a whole drafted To-do list). Prefer ACTION-oriented items the user will actually DO (experiments, analyses, concrete steps) - they need NOT mirror the roadmap 1:1. The user can edit them afterward. Onboarding step 4: add_tasks is MANDATORY and must be called BEFORE open_overview - never open the Overview with an empty To-do.',
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
				return ok(`Added ${added.length} task(s). They are editable in the Project Overview tab.`);
			},
		},
		{
			name: 'open_roadmap',
			description: 'Switch the UI to the Roadmap tab and open THIS project\'s roadmap canvas in the editor. A new project already has exactly one empty roadmap, so this opens that one - it does NOT create a duplicate. Pass a short `title` so the roadmap is named (instead of "Untitled roadmap") and is opened from the list. Call this after the project title/summary are confirmed, to start planning the process. Onboarding step 2 - call it ONCE, and never create a roadmap yourself (either makes a duplicate).',
			inputSchema: {
				type: 'object',
				properties: { title: { type: 'string', description: 'Short descriptive roadmap title (e.g. the research theme).' } },
				additionalProperties: false,
			},
			handler: async (args) => {
				try {
					// Reveal the Roadmap sidebar (the list of roadmaps). The registered
					// command is the view-CONTAINER id verbatim - `workbench.view.ariaRoadmap`
					// with NO `.focus` suffix (that suffixed id is never registered, and
					// calling it throws and aborts the whole tool). Best-effort so a
					// missing sidebar can't stop the editor from opening.
					try { await vscode.commands.executeCommand('workbench.view.ariaRoadmap'); } catch { /* sidebar optional */ }
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
					return ok('Opened the roadmap on the Roadmap tab.');
				} catch (e) {
					return err(`Could not open the roadmap: ${(e as Error).message}`);
				}
			},
		},
		{
			name: 'open_overview',
			description: 'Switch the UI back to the Project Overview tab (e.g. after building the roadmap and updating the To-do, so the user can review). This opens the full-width Project Overview editor. Onboarding step 5 - call only AFTER add_tasks (never with an empty To-do). Then tell the user the To-do list is placed BELOW the roadmap, so they should scroll down under the roadmap to see it.',
			inputSchema: { type: 'object', properties: {}, additionalProperties: false },
			handler: async () => {
				try {
					await vscode.commands.executeCommand('aria.overview.open');
					return ok('Opened the Project Overview tab.');
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
			description: 'Check or uncheck ONE task. Only call after the user agreed to mark it complete. `done` defaults to true.',
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
				return ok(`Marked ${r.updated.length} task(s) ${done ? 'done' : 'not done'}.`);
			},
		},
		{
			name: 'propose_task_completion',
			description: 'Propose marking ONE task complete: shows an Accept/Reject badge in the Project Overview tab. Call this when a task looks finished, THEN ask the user in chat "○○ 완료로 표시할까요?". Do NOT mark it done yourself - wait for the user (they Accept in the tab or say yes, then you call set_task_done).',
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
				return r.proposed.length ? ok('Proposed. A badge is shown in the Project Overview tab; ask the user to confirm.') : ok('Not proposed (task unknown, already done, or already pending).');
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
				return ok(`Proposed ${r.proposed.length} task(s). Badges are shown in the Project Overview tab; ask the user to confirm (partial ok).`);
			},
		},
	];
}
