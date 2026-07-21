/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { DefaultSkillSpec, findMissingDefaultSkills } from '../common/defaultSkills';
import { skillsServices } from '../common/services';
import { discoverSkillsInRepo, fetchSkillMd, fetchSkillMdAtPath } from '../common/skillFetcher';
import { analyzeSkillMd } from '../common/claudeAnalyzer';
import { cloneFromGithub, installFromLocal, resolveBundledPath } from '../common/skillsManager';
import { log } from '../common/logger';
import { EnvVarRequirement, SkillDependency, SkillInfo } from '../common/types';

/**
 * Wizard A - runs once on a fresh install (or any time a default skill
 * is missing). Installs uv if it's not already on PATH, then clones the
 * default skill set into ~/.claude/skills/ so the user has a working
 * paper-search experience on first launch.
 *
 * The wizard is intentionally light on choices: the welcome screen
 * confirms the user wants to set up, and everything else runs inside a
 * single progress notification. We never silently bail - if a step
 * fails, we surface the error and keep the manifest's first-run flag
 * unset so the next launch can retry.
 */

export async function runFirstRunWizardIfNeeded(): Promise<void> {
	const svc = skillsServices();
	const manifest = svc.manifest.readManifest();
	const installedNames = svc.skills.listManaged().map(s => s.name);
	const missing = findMissingDefaultSkills(installedNames);

	// Always join the workbench startup tracking, even when there's
	// nothing to install - the summary toast still wants a line about
	// the default skills so the user sees their presence acknowledged.
	// We avoid listing individual skill names so the row stays stable
	// as the default set grows.
	await vscode.commands.executeCommand('aria.startup.beginTracking', 'aria-skills-firstrun');

	let summary = 'Default skills - already configured';
	let changed = false;
	let installedCount = 0;
	let failedCount = 0;

	try {
		if (missing.length === 0) {
			// All defaults present. Mark first-run as completed if it
			// wasn't already (e.g. defaults arrived via a manual install
			// before Qoka saw them) so we don't re-check on every launch.
			if (!manifest.firstRunCompleted) {
				svc.manifest.markFirstRunCompleted();
			}
			return;
		}

		log(`First-run wizard triggered. Missing ${missing.length} default skill(s).`);

		await ensureUvInstalled();
		for (const spec of missing) {
			try {
				await installOneDefault(spec);
				installedCount++;
			} catch (err) {
				const reason = (err as Error).message;
				log(`Failed to install default skill ${spec.name}: ${reason}`);
				failedCount++;
			}
		}

		if (installedCount > 0 && failedCount === 0) {
			svc.manifest.markFirstRunCompleted();
		}
	} finally {
		if (installedCount > 0 && failedCount === 0) {
			summary = 'Default skills installed';
			changed = true;
		} else if (installedCount > 0) {
			summary = `Default skills installed (${failedCount} failed)`;
			changed = true;
		} else if (failedCount > 0) {
			summary = `Default skill install failed`;
			changed = false;
		}
		// else: missing was empty → leaves the "already configured" default

		await vscode.commands.executeCommand(
			'aria.startup.markComplete',
			'aria-skills-firstrun',
			summary,
			changed,
		);
	}

	// If anything actually changed on disk, ping the Skills sidebar so
	// the new defaults show up without forcing the user to click the
	// refresh icon. Best-effort - the command is a no-op when the view
	// isn't mounted yet, and the view's own refresh-on-open will fill
	// in when the user navigates to it.
	if (installedCount > 0) {
		void vscode.commands.executeCommand('aria.skills.requestRefresh');
	}

	// We deliberately drop the old success/failure toasts here - the
	// unified post-startup toast covers the success case, and a
	// modal-style failure popup would clash with the overlay's
	// timing. Errors still land in the Output channel via log().
}

async function ensureUvInstalled(): Promise<void> {
	const svc = skillsServices();
	const existing = await svc.uv.detectUv();
	if (existing) {
		log(`uv already present at ${existing}`);
		return;
	}
	try {
		await svc.uv.installUv();
		log('uv installed successfully');
	} catch (err) {
		// We don't abort the whole wizard for a uv failure - many skills
		// don't need Python at all, and the user can install uv later.
		log(`uv install failed: ${(err as Error).message}`);
		// Don't show a modal here; the overlay is still up. We'll surface
		// the warning after the overlay drops in the calling function.
	}
}

/**
 * Clone a single default skill: resolve the SKILL.md (with multi-skill
 * repo fallback), run analysis to extract env vars, then git-clone the
 * folder into ~/.claude/skills/<name>/ and record the manifest entry
 * with type='default'.
 */
async function installOneDefault(spec: DefaultSkillSpec): Promise<void> {
	const svc = skillsServices();

	// App-bundled skill: copy from the extension's `skills/<...>` folder instead
	// of cloning from GitHub. `__dirname` is the bundled out/ dir, so '..' is the
	// extension root.
	if (spec.bundledPath) {
		const srcDir = resolveBundledPath(spec.bundledPath);
		const dest = installFromLocal(srcDir, spec.name);

		// Pre-registered skills (spec.envVars defined) register straight from the
		// curated metadata here - no AI-CLI analysis, no SKILL.md re-parse. That's
		// what makes first-run registration instant and offline. Only fall back to
		// analyzeSkillMd for a bundled skill that has NOT been pre-registered.
		let category = spec.category;
		let description = spec.description;
		let envVars: EnvVarRequirement[] = spec.envVars ?? [];
		let dependencies: SkillDependency[] = [];
		if (spec.envVars === undefined) {
			const skillMd = fs.readFileSync(path.join(srcDir, 'SKILL.md'), 'utf8');
			const analysis = await analyzeSkillMd(skillMd);
			category = analysis.category ?? spec.category;
			description = analysis.description ?? spec.description;
			envVars = analysis.envVars;
			dependencies = analysis.dependencies;
		}

		const skill: SkillInfo = {
			name: spec.name,
			category,
			description,
			source: `bundled:${spec.bundledPath}`,
			type: 'default',
			group: spec.group,
			hidden: spec.hidden,
			installedAt: new Date().toISOString(),
			envVars,
			dependencies,
			autoApprove: false,
			path: dest,
		};
		svc.skills.recordSkill(skill);
		svc.manifest.addCategory(skill.category);
		return;
	}

	if (!spec.url) {
		throw new Error(`Default skill "${spec.name}" has neither url nor bundledPath.`);
	}
	const specUrl = spec.url;

	let skillMd: string;
	let cloneUrl = specUrl;
	let categoryFromAnalysis: string | undefined;
	try {
		const direct = await fetchSkillMd(specUrl);
		skillMd = direct.content;
	} catch {
		// Try multi-skill discovery - paper-lookup happens to be at a
		// known sub-path, but other defaults might live in a monorepo
		// where the URL only points at the root.
		const discovered = await discoverSkillsInRepo(specUrl);
		if (discovered.skillSubPaths.length === 0) {
			throw new Error(`No SKILL.md found at ${specUrl}.`);
		}
		const first = discovered.skillSubPaths[0];
		const fetched = await fetchSkillMdAtPath(discovered.owner, discovered.repo, discovered.branch, first);
		skillMd = fetched.content;
		cloneUrl = `https://github.com/${discovered.owner}/${discovered.repo}/tree/${discovered.branch}/${first}`.replace(/\/$/, '');
	}

	const analysis = await analyzeSkillMd(skillMd);
	categoryFromAnalysis = analysis.category;

	const dest = await cloneFromGithub(cloneUrl, spec.name);
	const skill: SkillInfo = {
		name: spec.name,
		category: categoryFromAnalysis ?? spec.category,
		description: analysis.description ?? spec.description,
		source: cloneUrl,
		type: 'default',
		group: spec.group,
		hidden: spec.hidden,
		installedAt: new Date().toISOString(),
		envVars: analysis.envVars,
		dependencies: analysis.dependencies,
		autoApprove: false,
		path: dest,
	};
	svc.skills.recordSkill(skill);
	svc.manifest.addCategory(skill.category);
}
