/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { buildDefaultServices, setSkillsServices, skillsServices } from './common/services';
import { SkillInfo } from './common/types';
import { runAddSkillWizard } from './wizards/addSkillWizard';
import { runFirstRunWizardIfNeeded } from './wizards/firstRunWizard';
import { initLogger, log, showLogger } from './common/logger';
import { setSkillAutoApprove } from './common/permissions';
import { ensureEnvFile } from './common/envManager';
import { ensureAriaHook } from './common/ariaHooks';
import { reconcileCategories } from './common/skillManifest';

/**
 * Skills extension entry. Phase 2 replaces the central-area webview with
 * a sidebar-driven UI hosted in the workbench's AriaSkillsView. The view
 * pulls all state through the `aria.skills.getState` command we register
 * here so the workbench-side code stays free of any extension imports.
 */

export function activate(context: vscode.ExtensionContext): void {
	console.log('[aria-skills] activate()');

	// Bring up the Output channel first so any setup-time errors land
	// somewhere the user can find them.
	initLogger();
	log('Aria Skills extension activated.');

	// Touch ~/.env on startup so "Open ~/.env" always opens something.
	ensureEnvFile();

	// Register the Aria PreToolUse hook with Claude Code. The hook
	// injects Aria's environment rules whenever Claude is about to run
	// a shell command that touches .env files, pip/conda installs, or
	// credential env vars — so skill SKILL.md instructions to "create a
	// .env file" get overridden in favour of Aria's Skills tab.
	ensureAriaHook();

	setSkillsServices(buildDefaultServices());

	// Drop any leftover "Literature", "Protein"… entries that older
	// builds seeded the manifest with. Categories are now fully
	// user-driven and only ones a real skill claims should remain.
	reconcileCategories();

	context.subscriptions.push(
		// Single read endpoint the sidebar calls on mount + after every
		// state change. Returning a plain object keeps the IPC payload
		// small and deterministic.
		vscode.commands.registerCommand('aria.skills.getState', async () => getState()),

		// Opens the env file in an editor tab when the sidebar wants to
		// surface it. Falls back to a notification when no env file exists
		// yet (the more common case before any keys are saved).
		vscode.commands.registerCommand('aria.skills.openEnvFile', async () => {
			const envPath = skillsServices().env.envPath();
			ensureEnvFile();
			const doc = await vscode.workspace.openTextDocument(envPath);
			await vscode.window.showTextDocument(doc);
		}),

		// Wizard B — the actual "Add Skill" flow. We keep the legacy
		// `addSkillStub` command name so the workbench-side button
		// wiring stays the same, and add `openAddWizard` as the canonical
		// alias for future call sites.
		vscode.commands.registerCommand('aria.skills.openAddWizard', () => runAddSkillWizard()),
		vscode.commands.registerCommand('aria.skills.addSkillStub', () => runAddSkillWizard()),

		// Reveal the Output channel so the user can read the most recent
		// Claude exchange / regex fallback trace without hunting for it.
		vscode.commands.registerCommand('aria.skills.showLog', () => showLogger()),

		// Per-skill key configuration. Called from the sidebar when the
		// user clicks the "Configure keys" button on a skill card. Loops
		// through that skill's declared env vars and writes whatever the
		// user types straight to ~/.env via the env service — keys never
		// leave Aria's TS code (no Claude prompt, no log line).
		vscode.commands.registerCommand('aria.skills.configureKeys', (skillName: unknown) => {
			if (typeof skillName !== 'string') {
				return;
			}
			return configureKeysForSkill(skillName);
		}),

		// Single-variable inline edit, fired from the Edit button next
		// to each env var in the Environment Variables section. Shows
		// the current value UNMASKED so the user can see+edit it. This
		// is OK because: the input is the user's own editor, in their
		// own UI, on their own machine — masking it there would just
		// stop them from editing a typo'd key.
		vscode.commands.registerCommand('aria.skills.editEnvVar', (name: unknown) => {
			if (typeof name !== 'string') {
				return;
			}
			return editSingleEnvVar(name);
		}),

		// Open an input box pre-filled with the skill's current category
		// so the user can rename it. The view also exposes a direct
		// `aria.skills.updateCategory` command (no prompt) for the × clear
		// button on the category pill.
		vscode.commands.registerCommand('aria.skills.editCategory', (skillName: unknown) => {
			if (typeof skillName !== 'string') {
				return;
			}
			return promptEditCategory(skillName);
		}),
		vscode.commands.registerCommand('aria.skills.updateCategory', (skillName: unknown, category: unknown) => {
			if (typeof skillName !== 'string' || typeof category !== 'string') {
				return;
			}
			return updateCategory(skillName, category);
		}),

		// Re-run the first-run wizard on demand. Wired to a command in
		// case the user wants to re-install defaults from a clean slate
		// after a manual ~/.claude/skills/ edit.
		vscode.commands.registerCommand('aria.skills.runFirstRunWizard', () => runFirstRunWizardIfNeeded()),

		// Triggered by the workbench startup overlay once all tracked
		// setup tasks finish. Shows a single, unified "Setup complete"
		// toast with a click-through to a modal listing each task's
		// outcome. Living in aria-skills (not in the workbench) so we
		// can use vscode.window APIs — workbench code can't.
		vscode.commands.registerCommand('aria.startup.showSummaryToast', (summaries: unknown) => showStartupSummaryToast(summaries)),

		// Uninstall a user skill. Defaults are excluded by the UI — the
		// user is expected to re-run first-run setup if they want to
		// replace a default.
		vscode.commands.registerCommand('aria.skills.uninstallSkill', async (skillName: unknown) => {
			if (typeof skillName !== 'string') {
				return;
			}
			const confirm = await vscode.window.showWarningMessage(
				`Uninstall "${skillName}"? This removes ~/.claude/skills/${skillName} and the manifest entry. ~/.env keys are kept.`,
				{ modal: true },
				'Uninstall',
			);
			if (confirm !== 'Uninstall') {
				return;
			}
			try {
				await skillsServices().skills.uninstall(skillName);
				setSkillAutoApprove(skillName, false);
				void vscode.commands.executeCommand('aria.skills.requestRefresh');
				vscode.window.showInformationMessage(`Uninstalled "${skillName}".`);
			} catch (err) {
				vscode.window.showErrorMessage(`Failed to uninstall: ${(err as Error).message}`);
			}
		}),
	);

	// Kick off the first-run wizard non-blockingly. It self-skips when
	// defaults are already present, so the cost of always firing it is
	// one read of the manifest plus one stat() per default skill.
	void runFirstRunWizardIfNeeded();
}

/** Snapshot returned to the sidebar view. Keep this in sync with the
 *  AriaSkillsState interface in ariaSkillsView.ts. */
type DecoratedSkill = SkillInfo & {
	missingKeyCount: number;
	totalKeyCount: number;
	requiredCount: number;
	requiredMissingCount: number;
	optionalCount: number;
	optionalMissingCount: number;
};

interface AriaSkillsState {
	defaults: DecoratedSkill[];
	users: DecoratedSkill[];
	categories: string[];
	envVars: {
		name: string;
		value: string;
		usedBy: string[];
		/** Best human-readable description we have for this var, picked
		 *  from the skill manifests that declare it. Used by the sidebar
		 *  to show a one-line summary above "Used by:". */
		description: string | undefined;
		/** Sign-up / "obtain key here" URL the skill author surfaced.
		 *  We only show it inside the Edit dialog, not the sidebar, so
		 *  the panel stays uncluttered. */
		obtainUrl: string | undefined;
		/** True when ANY skill that uses this variable marks it required.
		 *  Drives the Required / Optional grouping in the env panel. */
		required: boolean;
	}[];
	uvDetected: boolean;
	uvPath: string | null;
}

async function getState(): Promise<AriaSkillsState> {
	const svc = skillsServices();
	const allSkills = svc.skills.reconcileWithDisk();
	const envValues = svc.env.readEnv();

	// Decorate each skill with required/optional env-var counts so the
	// sidebar can render separate "required ✓" and "optional" pills
	// without re-walking the env file per card.
	const decorate = (s: SkillInfo): DecoratedSkill => {
		const hasValue = (name: string) => !!(envValues[name] && envValues[name].length > 0);
		const required = s.envVars.filter(v => v.required);
		const optional = s.envVars.filter(v => !v.required);
		const requiredMissing = required.filter(v => !hasValue(v.name)).length;
		const optionalMissing = optional.filter(v => !hasValue(v.name)).length;
		return {
			...s,
			totalKeyCount: s.envVars.length,
			missingKeyCount: requiredMissing + optionalMissing,
			requiredCount: required.length,
			requiredMissingCount: requiredMissing,
			optionalCount: optional.length,
			optionalMissingCount: optionalMissing,
		};
	};

	const defaults = allSkills.filter(s => s.type === 'default').map(decorate);
	const users = allSkills.filter(s => s.type === 'user').map(decorate);
	const categories = svc.manifest.readManifest().categories;

	// Union of env vars across all installed skills. Each var lists which
	// skills depend on it AND carries the first non-empty description we
	// find — usually written by Claude during skill analysis, occasionally
	// the regex fallback. Lets the sidebar surface a one-liner above the
	// "Used by:" row.
	const usageByVar = new Map<string, {
		usedBy: string[];
		description: string | undefined;
		obtainUrl: string | undefined;
		required: boolean;
	}>();
	for (const skill of allSkills) {
		for (const v of skill.envVars) {
			const prior = usageByVar.get(v.name);
			if (prior) {
				prior.usedBy.push(skill.name);
				if (!prior.description && v.description) {
					prior.description = v.description;
				}
				if (!prior.obtainUrl && v.obtainUrl) {
					prior.obtainUrl = v.obtainUrl;
				}
				if (v.required) {
					prior.required = true;
				}
			} else {
				usageByVar.set(v.name, {
					usedBy: [skill.name],
					description: v.description,
					obtainUrl: v.obtainUrl,
					required: v.required,
				});
			}
		}
	}
	const envVars: AriaSkillsState['envVars'] = [...usageByVar.entries()].map(
		([name, info]) => ({
			name,
			value: envValues[name] ?? '',
			usedBy: info.usedBy,
			description: info.description,
			obtainUrl: info.obtainUrl,
			required: info.required,
		}),
	).sort((a, b) => a.name.localeCompare(b.name));

	const uvPath = await svc.uv.detectUv();

	return {
		defaults,
		users,
		categories,
		envVars,
		uvDetected: uvPath !== null,
		uvPath,
	};
}

/**
 * Walk the user through every env var a single skill expects, filling
 * in whichever values they want and saving them to ~/.env. We don't
 * touch values the user leaves blank — that way they can update one
 * key without re-typing the others.
 */
async function configureKeysForSkill(skillName: string): Promise<void> {
	const svc = skillsServices();
	const skill = svc.skills.listManaged().find(s => s.name === skillName);
	if (!skill) {
		vscode.window.showWarningMessage(`Skill "${skillName}" not found in the manifest.`);
		return;
	}
	if (skill.envVars.length === 0) {
		vscode.window.showInformationMessage(`"${skillName}" doesn't declare any environment variables.`);
		return;
	}
	const existing = svc.env.readEnv();
	const updates: Record<string, string> = {};
	for (let i = 0; i < skill.envVars.length; i++) {
		const v = skill.envVars[i];
		const currentValue = existing[v.name] ?? '';
		const promptParts = [
			v.description ?? `Value for ${v.name}.`,
			v.obtainUrl ? `Obtain at: ${v.obtainUrl}` : '',
			currentValue ? '(Leave blank to keep the existing value.)' : '',
		].filter(Boolean);
		const value = await vscode.window.showInputBox({
			title: `Configure ${skillName} — ${i + 1}/${skill.envVars.length}`,
			prompt: promptParts.join(' '),
			placeHolder: v.required ? `${v.name} (required)` : `${v.name} (optional)`,
			ignoreFocusOut: true,
			password: !/EMAIL$|_URL$/.test(v.name),
		});
		if (value === undefined) {
			// User dismissed the prompt — write whatever we've collected
			// so far and stop. Partial saves beat losing progress.
			break;
		}
		if (value.trim().length > 0) {
			updates[v.name] = value.trim();
		}
	}
	if (Object.keys(updates).length === 0) {
		vscode.window.showInformationMessage('No changes saved.');
		return;
	}
	try {
		svc.env.writeEnv(updates);
		vscode.window.showInformationMessage(
			`Saved ${Object.keys(updates).length} value(s) to ~/.env. Click the refresh icon to update the Skills tab.`,
		);
	} catch (err) {
		vscode.window.showErrorMessage(`Failed to write ~/.env: ${(err as Error).message}`);
	}
}

/**
 * Inline edit for a single env var. Pops an InputBox seeded with the
 * current value (unmasked), saves on submit, prompts before clearing.
 */
async function editSingleEnvVar(name: string): Promise<void> {
	const svc = skillsServices();
	const existing = svc.env.readEnv();
	const currentValue = existing[name] ?? '';

	// Surface which skills depend on this var so the user knows the
	// blast radius of the edit before they commit it. Also pull the
	// best description + obtainUrl from the manifest so the prompt
	// actually tells the user WHAT to enter, not just the var name.
	const managed = svc.skills.listManaged();
	const usedBy: string[] = [];
	let description: string | undefined;
	let obtainUrl: string | undefined;
	for (const s of managed) {
		const match = s.envVars.find(v => v.name === name);
		if (!match) {
			continue;
		}
		usedBy.push(s.name);
		if (!description && match.description) {
			description = match.description;
		}
		if (!obtainUrl && match.obtainUrl) {
			obtainUrl = match.obtainUrl;
		}
	}

	const promptParts = [
		description,
		obtainUrl ? `Get it at: ${obtainUrl}` : undefined,
		usedBy.length > 0 ? `Used by: ${usedBy.join(', ')}` : 'Not currently used by any installed skill.',
	].filter((s): s is string => !!s);

	const next = await vscode.window.showInputBox({
		title: `Edit ${name}`,
		prompt: promptParts.join('  •  '),
		value: currentValue,
		password: false,
		ignoreFocusOut: true,
	});
	if (next === undefined) {
		return;
	}

	if (next === '' && currentValue !== '') {
		const confirm = await vscode.window.showWarningMessage(
			`Clear ${name}? The variable will be saved as an empty value in ~/.env.`,
			{ modal: true },
			'Clear',
		);
		if (confirm !== 'Clear') {
			return;
		}
	}

	try {
		svc.env.writeEnv({ [name]: next });
		vscode.window.showInformationMessage(
			next === '' ? `${name} cleared.` : `${name} updated.`,
		);
	} catch (err) {
		vscode.window.showErrorMessage(`Failed to save ${name}: ${(err as Error).message}`);
	}
}

/**
 * Open an input box pre-filled with the skill's current category so the
 * user can rename it. Wired to the category pill's click handler in the
 * sidebar. Empty input is treated as "clear" — the manifest stores an
 * empty string, which the view renders as "+ Set category".
 */
async function promptEditCategory(skillName: string): Promise<void> {
	const svc = skillsServices();
	const skill = svc.skills.listManaged().find(s => s.name === skillName);
	if (!skill) {
		vscode.window.showWarningMessage(`Skill "${skillName}" not found in the manifest.`);
		return;
	}
	const next = await vscode.window.showInputBox({
		title: `Category for ${skillName}`,
		prompt: 'Type a category name. Leave empty to clear.',
		value: skill.category ?? '',
		ignoreFocusOut: true,
	});
	if (next === undefined) {
		return;
	}
	await updateCategory(skillName, next.trim());
}

/**
 * Persist a category change to the manifest. Also adds the new value to
 * the canonical category list so the dropdown filter picks it up on the
 * next refresh, and pings the sidebar to repaint.
 */
async function updateCategory(skillName: string, category: string): Promise<void> {
	const svc = skillsServices();
	const skill = svc.skills.listManaged().find(s => s.name === skillName);
	if (!skill) {
		vscode.window.showWarningMessage(`Skill "${skillName}" not found in the manifest.`);
		return;
	}
	svc.manifest.updateSkill(skillName, { category });
	if (category) {
		svc.manifest.addCategory(category);
	}
	log(`Category for "${skillName}" set to "${category}".`);
	void vscode.commands.executeCommand('aria.skills.requestRefresh');
}

/** Show the unified post-startup summary. Receives the list the workbench
 *  buffered while the overlay was up. */
async function showStartupSummaryToast(raw: unknown): Promise<void> {
	if (!Array.isArray(raw) || raw.length === 0) {
		return;
	}
	type Entry = { name: string; summary: string; changed: boolean };
	const entries = raw.flatMap((r): Entry[] => {
		if (!r || typeof r !== 'object') {
			return [];
		}
		const o = r as Record<string, unknown>;
		if (typeof o.summary !== 'string' || typeof o.name !== 'string') {
			return [];
		}
		return [{ name: o.name, summary: o.summary, changed: !!o.changed }];
	});
	if (entries.length === 0) {
		return;
	}

	const choice = await vscode.window.showInformationMessage(
		'Setup complete',
		'Show summary',
	);
	if (choice !== 'Show summary') {
		return;
	}

	// Standalone notification — only when an MCP was newly (re-)registered
	// this run. Claude Code caches the active MCP server list at chat-
	// session start, so an open chat won't see the new tools until the
	// user starts a new conversation. We surface this on its own (NOT
	// folded into the summary modal) so users who skip "Show summary"
	// still get the heads-up. Fire-and-forget so it doesn't block the
	// summary toast below.
	const mcpNewlyRegistered = entries.some(e => e.name.endsWith('-mcp') && e.changed);
	if (mcpNewlyRegistered) {
		void vscode.window.showInformationMessage(
			'A new MCP was registered with Claude Code. Start a new chat to use the new tools.',
		);
	}

	// ✓ marks freshly-applied changes; ○ marks "already configured"
	// (the task ran but didn't have to write anything).
	const detail = entries
		.map(e => `${e.changed ? '✓' : '○'} ${e.summary}`)
		.join('\n');
	await vscode.window.showInformationMessage(
		'Aria startup summary',
		{ modal: true, detail },
		'OK',
	);
}

export function deactivate(): void {
	console.log('[aria-skills] deactivate()');
}
