/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { analyzeSkillMd } from '../common/claudeAnalyzer';
import { discoverSkillsInRepo, fetchSkillMd, fetchSkillMdAtPath } from '../common/skillFetcher';
import { skillsServices } from '../common/services';
import { EnvVarRequirement, SkillDependency, SkillInfo } from '../common/types';
import {
	cloneFromGithub,
	deriveSkillName,
	isInstalledOnDisk,
	parseGithubUrl,
	skillPath,
} from '../common/skillsManager';

/**
 * Wizard B — guides the user through adding a new skill from a GitHub
 * URL. The flow is intentionally native: each step is a built-in
 * vscode.window prompt (input box / quick pick) instead of a webview,
 * so it stays available even in restricted profiles.
 *
 * Flow:
 *   1. Ask for a GitHub URL.
 *   2. Show a progress notification while we fetch + analyze SKILL.md.
 *   3. Let the user confirm/edit the name, category, and description.
 *   4. If dependencies were detected, ask for consent to install them.
 *   5. For each declared env var, ask for a value (skippable).
 *   6. Clone the repo into ~/.claude/skills/<name>/, record the
 *      manifest entry, and toast the result.
 */

export async function runAddSkillWizard(): Promise<void> {
	const url = await askForUrl();
	if (!url) {
		return;
	}

	// Resolve the URL down to a specific SKILL.md. When the user pasted
	// a multi-skill repo URL we fan out to a picker step here so the
	// rest of the wizard works against a single skill.
	const resolved = await resolveSkillSource(url);
	if (!resolved) {
		return;
	}

	const analyzed = await vscode.window.withProgress(
		{
			location: vscode.ProgressLocation.Notification,
			title: `Analyzing ${resolved.displayName}...`,
			cancellable: false,
		},
		async () => analyzeSkillMd(resolved.skillMd),
	).then(r => r, err => {
		vscode.window.showErrorMessage(`Failed to analyze skill: ${(err as Error).message}`);
		return undefined;
	});

	if (!analyzed) {
		return;
	}

	if (analyzed.fallbackReason) {
		vscode.window.showInformationMessage(analyzed.fallbackReason);
	}

	const name = await confirmName(analyzed.name ?? resolved.suggestedName);
	if (!name) {
		return;
	}

	if (isInstalledOnDisk(name)) {
		const overwrite = await vscode.window.showWarningMessage(
			`A skill named "${name}" is already installed. Reinstall it?`,
			{ modal: true },
			'Reinstall',
		);
		if (overwrite !== 'Reinstall') {
			return;
		}
		// Remove on-disk + manifest entry before re-cloning.
		try {
			await skillsServices().skills.uninstall(name);
		} catch (err) {
			vscode.window.showErrorMessage(`Could not remove existing skill: ${(err as Error).message}`);
			return;
		}
	}

	const category = await pickCategory(analyzed.category);
	if (!category) {
		return;
	}

	const description = await editDescription(analyzed.description ?? '');
	if (description === undefined) {
		return;
	}

	if (analyzed.dependencies.length > 0) {
		const accepted = await confirmDependencies(analyzed.dependencies);
		if (!accepted) {
			return;
		}
	}

	const envValues = await collectEnvVarValues(analyzed.envVars);
	if (envValues === undefined) {
		return;
	}

	// Persist env values BEFORE cloning so a clone failure doesn't leave
	// orphan keys in ~/.env. dotenv-style write is atomic.
	if (Object.keys(envValues).length > 0) {
		try {
			skillsServices().env.writeEnv(envValues);
		} catch (err) {
			vscode.window.showErrorMessage(`Could not save environment variables: ${(err as Error).message}`);
			return;
		}
	}

	const installed = await vscode.window.withProgress(
		{
			location: vscode.ProgressLocation.Notification,
			title: `Installing ${name}...`,
			cancellable: false,
		},
		async () => {
			// `resolved.cloneUrl` may be a deeper tree URL than the one
			// the user originally pasted (e.g. when we narrowed a
			// multi-skill repo down to a specific subdirectory). That's
			// the right thing to clone — we only want the picked skill.
			const dest = await cloneFromGithub(resolved.cloneUrl, name);
			const skill: SkillInfo = {
				name,
				category,
				description: description ?? '',
				source: resolved.cloneUrl,
				type: 'user',
				installedAt: new Date().toISOString(),
				envVars: analyzed.envVars,
				dependencies: analyzed.dependencies,
				autoApprove: false,
				path: dest,
			};
			skillsServices().skills.recordSkill(skill);
			// Make sure the new category is in the manifest so the Skills
			// tab dropdown sees it on next refresh.
			skillsServices().manifest.addCategory(category);
			return skill;
		},
	).then(r => r, err => {
		vscode.window.showErrorMessage(`Install failed: ${(err as Error).message}`);
		return undefined;
	});

	if (!installed) {
		return;
	}

	// Ping the Skills sidebar to repaint with the new skill. The
	// workbench side registers `aria.skills.requestRefresh`; the call
	// is a no-op when the view hasn't been opened yet, which is fine.
	void vscode.commands.executeCommand('aria.skills.requestRefresh');

	vscode.window.showInformationMessage(`Installed "${installed.name}".`);
}

/**
 * Resolve a user-pasted URL into a single skill we can clone. Handles
 * three shapes:
 *  1. URL points DIRECTLY at a SKILL.md location — return as-is.
 *  2. URL points at a multi-skill repo (no SKILL.md at path, but other
 *     SKILL.md files exist elsewhere in the tree) — fan out a quick pick.
 *  3. URL is genuinely a non-skill location — surface a clear error.
 */
interface ResolvedSkillSource {
	/** SKILL.md body text, fetched via raw content. */
	skillMd: string;
	/** GitHub URL pointing at the skill folder (NOT the SKILL.md file). */
	cloneUrl: string;
	/** Pretty display string for the progress toast. */
	displayName: string;
	/** Folder-name suggestion (used when SKILL.md has no `name:` field). */
	suggestedName: string;
}

async function resolveSkillSource(url: string): Promise<ResolvedSkillSource | undefined> {
	// Try the user's exact URL first — happy path for "this URL is the
	// single skill" case.
	try {
		const direct = await fetchSkillMd(url);
		return {
			skillMd: direct.content,
			cloneUrl: url,
			displayName: deriveSkillName(url),
			suggestedName: deriveSkillName(url),
		};
	} catch {
		// Fall through to discovery — this URL didn't expose a SKILL.md
		// at the obvious path, but it might be a multi-skill repo root.
	}

	let discovered;
	try {
		discovered = await discoverSkillsInRepo(url);
	} catch (err) {
		vscode.window.showErrorMessage(
			`This URL doesn't appear to contain a SKILL.md, and we couldn't enumerate the repo (${(err as Error).message}). Paste a URL that points at a directory containing SKILL.md.`,
		);
		return undefined;
	}

	if (discovered.skillSubPaths.length === 0) {
		vscode.window.showErrorMessage(
			`No SKILL.md found anywhere under ${url}. Make sure the URL points at a Claude skill folder.`,
		);
		return undefined;
	}

	const pick = await pickSkillFromList(discovered.owner, discovered.repo, discovered.skillSubPaths);
	if (!pick) {
		return undefined;
	}

	const fetched = await vscode.window.withProgress(
		{
			location: vscode.ProgressLocation.Notification,
			title: `Downloading ${pick || discovered.repo}/SKILL.md...`,
			cancellable: false,
		},
		async () => fetchSkillMdAtPath(discovered.owner, discovered.repo, discovered.branch, pick),
	).then(r => r, err => {
		vscode.window.showErrorMessage(`Failed to read SKILL.md: ${(err as Error).message}`);
		return undefined;
	});

	if (!fetched) {
		return undefined;
	}

	const cloneUrl = `https://github.com/${discovered.owner}/${discovered.repo}/tree/${discovered.branch}/${pick}`.replace(/\/$/, '');
	const display = pick ? `${discovered.repo}/${pick}` : discovered.repo;
	const suggested = pick ? pick.split('/').pop()! : discovered.repo;
	return {
		skillMd: fetched.content,
		cloneUrl,
		displayName: display,
		suggestedName: suggested,
	};
}

async function pickSkillFromList(owner: string, repo: string, skillSubPaths: string[]): Promise<string | undefined> {
	const items: vscode.QuickPickItem[] = skillSubPaths.map(p => ({
		label: p || '(repo root)',
		description: p ? `https://github.com/${owner}/${repo}/tree/-/${p}` : undefined,
	}));
	const pick = await vscode.window.showQuickPick(items, {
		title: `${owner}/${repo} — pick a skill (${skillSubPaths.length} found)`,
		placeHolder: 'Which SKILL.md do you want to install?',
		ignoreFocusOut: true,
		matchOnDescription: true,
	});
	if (!pick) {
		return undefined;
	}
	return pick.label === '(repo root)' ? '' : pick.label;
}

async function askForUrl(): Promise<string | undefined> {
	const placeholder = 'https://github.com/owner/repo or .../tree/branch/path/to/skill';
	const value = await vscode.window.showInputBox({
		title: 'Add Skill — Step 1 of 6',
		prompt: 'Paste a GitHub URL pointing to the skill\'s repository or subdirectory.',
		placeHolder: placeholder,
		ignoreFocusOut: true,
		validateInput: (input) => {
			if (!input.trim()) {
				return 'A GitHub URL is required.';
			}
			if (!parseGithubUrl(input.trim())) {
				return 'That doesn\'t look like a github.com URL.';
			}
			return undefined;
		},
	});
	return value?.trim();
}

async function confirmName(initial: string): Promise<string | undefined> {
	const value = await vscode.window.showInputBox({
		title: 'Add Skill — Step 2 of 6',
		prompt: 'Confirm the skill name (used as the folder name in ~/.claude/skills/).',
		value: initial,
		ignoreFocusOut: true,
		validateInput: (input) => {
			const v = input.trim();
			if (!v) {
				return 'Name is required.';
			}
			if (!/^[A-Za-z0-9_.-]+$/.test(v)) {
				return 'Use only letters, digits, dot, dash, or underscore.';
			}
			return undefined;
		},
	});
	return value?.trim();
}

async function pickCategory(suggested: string | undefined): Promise<string | undefined> {
	const categories = skillsServices().manifest.readManifest().categories;
	const items: vscode.QuickPickItem[] = [];
	if (suggested && !categories.includes(suggested)) {
		items.push({ label: suggested, description: '(suggested)' });
	}
	for (const c of categories) {
		items.push({
			label: c,
			description: c === suggested ? '(suggested)' : undefined,
		});
	}
	items.push({ label: '$(add) Custom...', description: 'Type a new category name' });
	items.push({ label: '$(circle-slash) Skip', description: 'Leave the category blank' });

	const pick = await vscode.window.showQuickPick(items, {
		title: 'Add Skill — Step 3 of 6',
		placeHolder: 'Select a category for this skill.',
		ignoreFocusOut: true,
		matchOnDescription: true,
	});
	if (!pick) {
		return undefined;
	}
	if (pick.label.startsWith('$(add)')) {
		const custom = await vscode.window.showInputBox({
			title: 'Add Skill — Step 3 of 6 (custom category)',
			prompt: 'Name your new category.',
			ignoreFocusOut: true,
			validateInput: (input) => {
				const v = input.trim();
				if (!v) {
					return 'Category name is required.';
				}
				return undefined;
			},
		});
		return custom?.trim();
	}
	if (pick.label.startsWith('$(circle-slash)')) {
		return '';
	}
	return pick.label;
}

async function editDescription(initial: string): Promise<string | undefined> {
	return vscode.window.showInputBox({
		title: 'Add Skill — Step 4 of 6',
		prompt: 'Edit the short description shown on the skill card. Leave empty to skip.',
		value: initial,
		ignoreFocusOut: true,
	});
}

async function confirmDependencies(deps: SkillDependency[]): Promise<boolean> {
	const lines = deps.map(d => `• ${d.name}${d.required ? ' (required)' : ''}${d.reason ? ` — ${d.reason}` : ''}`).join('\n');
	const choice = await vscode.window.showWarningMessage(
		`This skill expects the following dependencies. Aria currently records them in the manifest only — install them yourself if needed.\n\n${lines}`,
		{ modal: true },
		'Continue',
		'Cancel',
	);
	return choice === 'Continue';
}

async function collectEnvVarValues(envVars: EnvVarRequirement[]): Promise<Record<string, string> | undefined> {
	if (envVars.length === 0) {
		return {};
	}
	// Give the user an out before we drag them through an N-step input
	// loop. Most API keys live behind sign-up flows the user has to step
	// away to complete; forcing them to abort the whole wizard to do
	// that is the opposite of helpful.
	const keysLine = envVars.map(v => `• ${v.name}${v.required ? ' (required)' : ' (optional)'}`).join('\n');
	const choice = await vscode.window.showQuickPick(
		[
			{
				label: '$(arrow-right) Skip — configure keys later',
				description: 'Install the skill now and add keys from the Skills tab when ready.',
			},
			{
				label: '$(key) Enter keys now',
				description: 'Step through each variable in this wizard.',
			},
		],
		{
			title: `Add Skill — Step 5 of 6 (${envVars.length} key(s) needed)`,
			placeHolder: `This skill expects:\n${keysLine}`,
			ignoreFocusOut: true,
		},
	);
	if (!choice) {
		return undefined;
	}
	if (choice.label.startsWith('$(arrow-right)')) {
		return {};
	}

	const existing = skillsServices().env.readEnv();
	const updates: Record<string, string> = {};
	for (let i = 0; i < envVars.length; i++) {
		const v = envVars[i];
		const stepNo = `Add Skill — Step 5 of 6 (env var ${i + 1}/${envVars.length})`;
		const existingValue = existing[v.name] ?? '';
		const promptParts = [
			v.description ? v.description : `Value for ${v.name}.`,
			v.obtainUrl ? `Obtain at: ${v.obtainUrl}` : '',
			existingValue ? '(A value is already saved; leave blank to keep it.)' : '',
		].filter(Boolean);
		const value = await vscode.window.showInputBox({
			title: stepNo,
			prompt: promptParts.join(' '),
			placeHolder: v.required ? `${v.name} (required)` : `${v.name} (optional)`,
			ignoreFocusOut: true,
			password: !/EMAIL$|_URL$/.test(v.name),
		});
		if (value === undefined) {
			return undefined;
		}
		if (value.trim().length > 0) {
			updates[v.name] = value.trim();
		}
	}
	return updates;
}

/** Helper for the panel: open the env file via the existing command. */
export function skillsInstallPath(name: string): string {
	return skillPath(name);
}
