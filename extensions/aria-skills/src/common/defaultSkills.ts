/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { EnvVarRequirement } from './types';

/**
 * The set of skills Qoka installs on first run. Keeping the list here
 * (instead of in a config file) makes it visible in code review and
 * lets the first-run wizard treat each entry as a hard requirement.
 *
 * Adding a new default skill is a single line: append to DEFAULT_SKILLS.
 * The first-run wizard will pick it up automatically the next time it
 * runs on a fresh install.
 *
 * Every K-Dense skill below is app-bundled (`bundledPath` + a folder under
 * `extensions/aria-skills/skills/<name>/`) and carries pre-registered
 * metadata (`description` + `envVars`). That lets the first-run wizard
 * register them WITHOUT any network clone or AI-CLI analysis - it just
 * copies the folder and writes the manifest from the curated fields here.
 * The upstream source for the K-Dense set is
 * https://github.com/K-Dense-AI/scientific-agent-skills/tree/main/skills/<name>;
 * refresh a bundled copy from there (and re-verify its `envVars`) when the
 * skill changes.
 */
export interface DefaultSkillSpec {
	/** Folder name used under ~/.claude/skills/. Also the manifest key. */
	name: string;
	/** GitHub URL the wizard will clone from (sub-paths supported). Provide this
	 *  OR `bundledPath` - not both. */
	url?: string;
	/** App-bundled skill folder, relative to the aria-skills extension root
	 *  (e.g. 'skills/iterative-paper-defense'). When set, the wizard copies it
	 *  into ~/.claude/skills/ instead of cloning from GitHub - no network. */
	bundledPath?: string;
	/** Category label shown in the Skills tab. */
	category: string;
	/** Short blurb used until SKILL.md analysis fills in a better one. */
	description: string;
	/** Optional grouping label. Default skills that share a `group` are rendered
	 *  under one collapsible sub-section in the Skills tab (e.g. 'K-Dense' bundles
	 *  every skill sourced from the K-Dense scientific-agent-skills repo). Omit to
	 *  render the skill at the top level of the Default Skills section. */
	group?: string;
	/** Pre-registered environment variables, transcribed from the bundled
	 *  SKILL.md's author declaration (frontmatter `metadata.openclaw.envVars`
	 *  or the SKILL.md's own key table). When defined - EVEN as an empty array -
	 *  the first-run wizard registers the skill from this list DIRECTLY and skips
	 *  the AI-CLI analysis entirely (fast, offline, deterministic). Leave
	 *  undefined to fall back to analyzeSkillMd at install time. */
	envVars?: EnvVarRequirement[];
	/** Hidden skills install + mirror to providers like any other, but never
	 *  appear in the Skills tab. Used for the internal Qoka tool-routing guide. */
	hidden?: boolean;
}

export const DEFAULT_SKILLS: DefaultSkillSpec[] = [
	// DISABLED ON PURPOSE - do not delete. The hidden `using-qoka` routing skill
	// (skills/using-qoka/SKILL.md) duplicates what Codex now gets from
	// ~/.codex/AGENTS.md and Claude gets from the overview MCP's server
	// instructions. Running both at once makes it impossible to tell WHICH channel
	// is actually steering the model, so the skill stays off while we verify that
	// AGENTS.md alone works for Codex. Re-enable by uncommenting if it does not.
	// {
	// 	name: 'using-qoka',
	// 	bundledPath: 'skills/using-qoka',
	// 	category: 'Qoka',
	// 	description: 'Internal Qoka tool-routing guide - directs the AI to use Qoka MCP tools for research tasks.',
	// 	hidden: true,
	// 	envVars: [],
	// },
	{
		name: 'paper-lookup',
		bundledPath: 'skills/paper-lookup',
		category: 'Literature',
		description: 'Look up academic papers across 10 sources (PubMed, arXiv, OpenAlex, Crossref…) for the Paper Search tab.',
		group: 'K-Dense',
		// All four keys are OPTIONAL - search works without any of them; they only
		// raise rate limits or unlock one source's full text (SKILL.md key table).
		envVars: [
			{ name: 'NCBI_API_KEY', required: false, description: 'NCBI API key - raises the PubMed/PMC rate limit from 3 to 10 requests/second.', obtainUrl: 'https://www.ncbi.nlm.nih.gov/account/settings/' },
			{ name: 'CORE_API_KEY', required: false, description: 'CORE API key - needed for CORE full-text retrieval.', obtainUrl: 'https://core.ac.uk/services/api' },
			{ name: 'S2_API_KEY', required: false, description: 'Semantic Scholar API key - avoids shared-pool 429 rate-limit errors.', obtainUrl: 'https://www.semanticscholar.org/product/api#api-key-form' },
			{ name: 'OPENALEX_API_KEY', required: false, description: 'OpenAlex API key - recommended for reliable access.', obtainUrl: 'https://openalex.org/settings/api' },
		],
	},
	{
		name: 'iterative-paper-defense',
		bundledPath: 'skills/iterative-paper-defense',
		category: 'Writing',
		description: 'AI peer review with iterative, non-fabricating defensive revision of a manuscript, for the Peer Review tab.',
		// Qoka-native skill (not K-Dense). Needs no keys - pre-registered empty so
		// first-run skips the CLI here too.
		envVars: [],
	},
	{
		name: 'scanpy',
		bundledPath: 'skills/scanpy',
		category: 'Bioinformatics',
		description: 'Single-cell RNA-seq analysis with Scanpy: QC, normalization, PCA/UMAP, clustering, and visualization.',
		group: 'K-Dense',
		envVars: [],
	},
	{
		name: 'anndata',
		bundledPath: 'skills/anndata',
		category: 'Bioinformatics',
		description: 'Work with AnnData (.h5ad) objects, the standard scverse container for single-cell and omics data.',
		group: 'K-Dense',
		envVars: [],
	},
	{
		name: 'scvi-tools',
		bundledPath: 'skills/scvi-tools',
		category: 'Bioinformatics',
		description: 'Probabilistic single-cell analysis with scvi-tools: batch correction, DE with uncertainty, multimodal integration.',
		group: 'K-Dense',
		envVars: [],
	},
	{
		name: 'bioservices',
		bundledPath: 'skills/bioservices',
		category: 'Bioinformatics',
		description: 'Unified access to 40+ bioinformatics databases (UniProt, KEGG, ChEMBL, Reactome) with cross-database ID mapping.',
		group: 'K-Dense',
		// NCBI BLAST identifies callers by email - optional, everything else works without it.
		envVars: [
			{ name: 'NCBI_EMAIL', required: false, description: 'Email for NCBI service identification.' },
		],
	},
	{
		name: 'gget',
		bundledPath: 'skills/gget',
		category: 'Bioinformatics',
		description: 'Fast queries to 20+ genomic databases: gene info, BLAST, PDB/AlphaFold structures, expression, and disease associations.',
		group: 'K-Dense',
		envVars: [],
	},
	{
		name: 'biopython',
		bundledPath: 'skills/biopython',
		category: 'Bioinformatics',
		description: 'Molecular biology toolkit for sequence handling, file parsing, NCBI/Entrez access, structures, and phylogenetics.',
		group: 'K-Dense',
		// Both optional - only the Bio.Entrez (NCBI) examples read them.
		envVars: [
			{ name: 'NCBI_EMAIL', required: false, description: 'Email for NCBI Entrez identification (required by NCBI policy for Entrez calls).' },
			{ name: 'NCBI_API_KEY', required: false, description: 'NCBI API key to raise Entrez rate limits.' },
		],
	},
];

/**
 * Filter the default-skill list down to entries that aren't yet
 * represented in the user's manifest. Used by the first-run wizard to
 * decide whether to prompt at all, and which skills to install.
 */
export function findMissingDefaultSkills(installedNames: string[]): DefaultSkillSpec[] {
	const installed = new Set(installedNames);
	return DEFAULT_SKILLS.filter(s => !installed.has(s.name));
}
