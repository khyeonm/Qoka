/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The set of skills Qoka installs on first run. Keeping the list here
 * (instead of in a config file) makes it visible in code review and
 * lets the first-run wizard treat each entry as a hard requirement.
 *
 * Adding a new default skill is a single line: append to DEFAULT_SKILLS.
 * The first-run wizard will pick it up automatically the next time it
 * runs on a fresh install.
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
}

export const DEFAULT_SKILLS: DefaultSkillSpec[] = [
	{
		name: 'paper-lookup',
		url: 'https://github.com/K-Dense-AI/scientific-agent-skills/tree/main/skills/paper-lookup',
		category: 'Literature',
		description: 'Look up academic papers across multiple sources for the Paper Search tab.',
		group: 'K-Dense',
	},
	{
		name: 'iterative-paper-defense',
		bundledPath: 'skills/iterative-paper-defense',
		category: 'Writing',
		description: 'AI peer review with iterative, non-fabricating defensive revision of a manuscript, for the Peer Review tab.',
	},
	{
		name: 'scanpy',
		url: 'https://github.com/K-Dense-AI/scientific-agent-skills/tree/main/skills/scanpy',
		category: 'Bioinformatics',
		description: 'Single-cell analysis with Scanpy: preprocessing, clustering, UMAP, and visualization.',
		group: 'K-Dense',
	},
	{
		name: 'anndata',
		url: 'https://github.com/K-Dense-AI/scientific-agent-skills/tree/main/skills/anndata',
		category: 'Bioinformatics',
		description: 'Work with AnnData objects, the standard container for single-cell and omics data.',
		group: 'K-Dense',
	},
	{
		name: 'scvi-tools',
		url: 'https://github.com/K-Dense-AI/scientific-agent-skills/tree/main/skills/scvi-tools',
		category: 'Bioinformatics',
		description: 'Probabilistic single-cell analysis with scvi-tools (deep generative models).',
		group: 'K-Dense',
	},
	{
		name: 'bioservices',
		url: 'https://github.com/K-Dense-AI/scientific-agent-skills/tree/main/skills/bioservices',
		category: 'Bioinformatics',
		description: 'Unified access to 40+ bioinformatics databases (UniProt, KEGG, ChEMBL, Reactome) with cross-database ID mapping.',
		group: 'K-Dense',
	},
	{
		name: 'gget',
		url: 'https://github.com/K-Dense-AI/scientific-agent-skills/tree/main/skills/gget',
		category: 'Bioinformatics',
		description: 'Fast queries to 20+ genomic databases: gene info, BLAST, PDB/AlphaFold structures, expression, and disease associations.',
		group: 'K-Dense',
	},
	{
		name: 'biopython',
		url: 'https://github.com/K-Dense-AI/scientific-agent-skills/tree/main/skills/biopython',
		category: 'Bioinformatics',
		description: 'Molecular biology toolkit for sequence handling, file parsing, NCBI/Entrez access, structures, and phylogenetics.',
		group: 'K-Dense',
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
