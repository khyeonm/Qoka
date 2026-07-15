/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Shared data types for Aria's Skills extension. Mirrors the SKILL.md
 * frontmatter shape plus Aria-specific manifest fields (category,
 * permission, install metadata) that don't live in the upstream skill.
 */

/** Whether a skill ships with Aria or was added by the user. */
export type SkillType = 'default' | 'user';

/** A single environment variable a skill depends on. */
export interface EnvVarRequirement {
	/** The exact name the skill expects in ~/.env, e.g. NCBI_API_KEY. */
	name: string;
	/** Short human-readable explanation of what the key does. */
	description?: string;
	/** Whether the skill works at all without it. */
	required: boolean;
	/** A URL the user can visit to obtain the key, when known. */
	obtainUrl?: string;
	/** An HTTP endpoint Aria can ping to validate the key, when known. */
	validationEndpoint?: string;
}

/** A skill this one depends on, so we can install/check together. */
export interface SkillDependency {
	/** Name of the upstream skill, e.g. "uv" or "scienceskillscommon". */
	name: string;
	/** Whether the skill won't run at all without it. */
	required: boolean;
	/** Reason text from the SKILL.md analysis (helps the user decide). */
	reason?: string;
}

/** An installed skill - what Aria's manifest tracks per entry. */
export interface SkillInfo {
	/** Stable identifier (matches the directory name in ~/.claude/skills/). */
	name: string;
	/** Aria-assigned category - used only for filtering in the Skills tab. */
	category: string;
	/** Short description for the Skills tab card. */
	description: string;
	/** Where the skill came from (GitHub URL or local path). */
	source: string;
	/** Whether the skill ships with Aria by default or was added later. */
	type: SkillType;
	/** ISO timestamp set when the skill was installed by Aria. */
	installedAt: string;
	/** Latest installed version string, if known (currently from SKILL.md). */
	version?: string;
	/** Required environment variables. Filled at install time. */
	envVars: EnvVarRequirement[];
	/** Skill-level dependencies that should be installed alongside. */
	dependencies: SkillDependency[];
	/** Permission state for Claude Code's auto-allow gate. */
	autoApprove: boolean;
	/** Resolved on-disk location of the skill directory. */
	path: string;
}

/** The full manifest persisted at ~/.config/aria/skills-manifest.json. */
export interface SkillsManifest {
	version: number;
	skills: SkillInfo[];
	/** Category list, including any user-added categories. */
	categories: string[];
	/** Whether the first-run wizard has completed at least once. */
	firstRunCompleted: boolean;
}

/** Categories are fully user-defined now - the manifest starts with an
 *  empty list and grows as the user adds skills or types a new value into
 *  the Category pill. Keeping the export name so older imports compile,
 *  but the array is intentionally empty. */
export const DEFAULT_CATEGORIES: string[] = [];

/** Manifest version - bump when the on-disk shape changes incompatibly. */
export const MANIFEST_VERSION = 1;
