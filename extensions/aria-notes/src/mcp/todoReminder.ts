/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

/**
 * "Todo completion" trigger, shared verbatim across the Qoka MCP servers whose
 * tools represent finishing a piece of work (autopipe run/pipeline, saving a
 * found paper, recording a peer review, writing a note, exporting a paper).
 * When such a tool returns a successful result, we append the project's open
 * To-do list to that result so the AI - which just did the work and knows what
 * it was - can propose marking a matching item complete. The code never guesses
 * which task was finished; it only surfaces the candidates at the right moment.
 * The AI does the semantic match, asks the user IN CHAT, and on a yes calls
 * set_task_done (which reveals the checked item in the Project Overview tab).
 *
 * This is a forcing function that does NOT rely on the AI polling get_tasks on
 * its own: the reminder rides the tool result the AI reads right after a step.
 *
 * NOTE: this file is intentionally duplicated (identical) in each MCP-serving
 * extension because they cannot cross-import. Keep the copies in sync.
 */

/** Structural shape of an MCP tool result - matches every server's CallToolResult
 *  without importing each extension's own type. Content items are typed loosely so
 *  every extension's result assigns to it. */
interface ToolResult {
	content: Array<{ type: string; text?: string }>;
	isError?: boolean;
}

/** Tool names that mean "a deliverable was produced" - matched by leading verb so
 *  new tools are covered without editing a list. `record_` catches record_review
 *  (the peer-review skill's terminal tool). Query/setup tools (get_/list_/check_/
 *  read_/search_/set_/open_/start_/prepare_...) are intentionally excluded. */
const PRODUCTIVE_VERB = /^(run|execute|save|create|export|publish|build|record)_/;

/** Don't re-inject the list within this window, so a burst of tools (or a review
 *  recording per-reviewer) nudges once, not every call. */
const THROTTLE_MS = 60_000;

interface RawTask { id?: unknown; label?: unknown; done?: unknown; }

function workspaceRoot(): string | undefined {
	return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

/** Open (not-done) tasks from the project's overview.json, or [] when there are
 *  none / no file. Read directly off disk - no dependency on the overview MCP. */
function openTasks(root: string): Array<{ id: string; label: string }> {
	try {
		const raw = fs.readFileSync(path.join(root, '.qoka', 'notebook', 'overview.json'), 'utf8');
		const parsed = JSON.parse(raw) as { tasks?: RawTask[] };
		const tasks = Array.isArray(parsed?.tasks) ? parsed.tasks : [];
		return tasks
			.filter(t => t && t.done !== true && typeof t.label === 'string' && typeof t.id === 'string')
			.map(t => ({ id: String(t.id), label: String(t.label) }));
	} catch {
		return [];
	}
}

/** Per-workspace throttle via a stamp file in the OS temp dir. Returns true when
 *  we injected too recently and should stay silent this time. */
function throttled(root: string): boolean {
	try {
		const key = Buffer.from(root).toString('base64').replace(/[^a-zA-Z0-9]/g, '').slice(0, 32);
		const stamp = path.join(os.tmpdir(), `qoka-todo-nudge-${key}`);
		const now = Date.now();
		if (fs.existsSync(stamp)) {
			const last = Number(fs.readFileSync(stamp, 'utf8')) || 0;
			if (now - last < THROTTLE_MS) {
				return true;
			}
		}
		fs.writeFileSync(stamp, String(now));
		return false;
	} catch {
		return false;
	}
}

/**
 * If `toolName` is a deliverable-producing tool, the call succeeded, and there
 * are open To-dos (and we didn't just nudge), append the open list to the result
 * so the AI can propose completing a matching item IN CHAT. Otherwise returns the
 * result unchanged. Never throws.
 */
export function maybeAppendTodoReminder(toolName: string, result: ToolResult): ToolResult {
	try {
		if (result.isError || !PRODUCTIVE_VERB.test(toolName)) {
			return result;
		}
		const root = workspaceRoot();
		if (!root) {
			return result;
		}
		const tasks = openTasks(root);
		if (tasks.length === 0 || throttled(root)) {
			return result;
		}
		const list = tasks.slice(0, 25).map(t => `- ${t.id}: ${t.label}`).join('\n');
		const reminder =
			`\n\n---\n[Qoka To-do check] Open items in this project:\n${list}\n`
			+ 'If the work you just completed finishes one of these, ASK THE USER IN CHAT (in their language) '
			+ 'whether to mark it complete. If they say yes, call set_task_done with its id - that checks it off '
			+ 'and opens the Project Overview tab so they see it. Do NOT use a tab Accept badge, and do not mark '
			+ 'it done without the user\'s yes. If none apply, ignore this.';
		return { ...result, content: [...result.content, { type: 'text', text: reminder }] };
	} catch {
		return result;
	}
}
