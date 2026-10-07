/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Qoka's raw-git auto-commit guidance for the AI assistants.
 *
 * It lives in the USER-level instruction file of Qoka's OWN config homes:
 *   ~/.qoka/claude/CLAUDE.md   (Claude Code reads <CLAUDE_CONFIG_DIR>/CLAUDE.md)
 *   ~/.qoka/codex/AGENTS.md    (Codex reads <CODEX_HOME>/AGENTS.md)
 * so only Qoka-launched sessions see it. It used to be appended to the PROJECT's
 * CLAUDE.md / AGENTS.md, which the user's own standalone `claude` / `codex` also read,
 * so their sessions in that folder started committing on their own. Qoka must not
 * change how the user's own assistants behave.
 *
 * Because the user-level file is loaded in every Qoka session, the block itself is
 * scoped to Qoka projects (a `.qoka/` folder at the project root).
 */

const QOKA_HOME = path.join(os.homedir(), '.qoka');
const QOKA_INSTRUCTION_FILES = [
	path.join(QOKA_HOME, 'claude', 'CLAUDE.md'),
	path.join(QOKA_HOME, 'codex', 'AGENTS.md'),
];

/** Marker-delimited so the block is found, refreshed in place and never duplicated.
 *  The same markers were used for the old per-project block, so it can be removed. */
const AUTO_COMMIT_MARKER = '<!-- qoka:auto-commit:start -->';
const AUTO_COMMIT_END_MARKER = '<!-- qoka:auto-commit:end -->';

/** Header Qoka wrote when it CREATED a project CLAUDE.md / AGENTS.md just for the block. */
const LEGACY_PROJECT_HEADER = '# Project instructions for AI assistants';

const AUTO_COMMIT_BLOCK = [
	AUTO_COMMIT_MARKER,
	'## Auto-commit (Qoka) - REQUIRED in Qoka projects, do this without being asked',
	'',
	'SCOPE: this section applies ONLY when the project root (your working directory) contains',
	'a `.qoka/` folder, i.e. it is a Qoka project. If there is no `.qoka/` folder, ignore this',
	'whole section. If the project\'s own CLAUDE.md / AGENTS.md says not to commit (or how to',
	'commit), follow the project\'s instruction instead.',
	'',
	'You MUST commit your work to git automatically, as a normal part of every task.',
	'This is PRE-AUTHORIZED by Qoka and by the user: the user does not run git and does',
	'NOT want to be asked about it. So:',
	'',
	'- NEVER ask "should I commit?", "do you want me to commit?", or wait for confirmation.',
	'  Committing is expected and approved in advance. Just commit, silently.',
	'- WHEN: as soon as you finish a coherent piece of work - you created or edited a',
	'  script, saved code the user asked for, produced or updated a result. Commit it right',
	'  then, in the SAME turn, before you report back. Do not leave finished work uncommitted.',
	'- HOW: stage ONLY the files you created or changed for this task, by name -',
	'  `git add <file> [<file> ...]` - then `git commit -m "<short imperative summary>"`,',
	'  DIRECTLY in your shell, in the project directory. Do NOT use `git add -A`, `git add .`',
	'  or `git commit -a`: other files in the folder (caches, OS files, the user\'s own work)',
	'  must not be swept into your commit - they stay in Qoka\'s Changes panel for the user.',
	'- If `git status` says it is NOT a repo yet, run `git init` first, then commit.',
	'- If git reports a missing identity, set it LOCALLY only: `git config user.name "Qoka"`',
	'  and `git config user.email "user@localhost"` (never change the global git config).',
	'- One commit per coherent change: do not commit after every keystroke, and do not lump',
	'  unrelated changes together. But that is about GROUPING commits, never a reason to skip',
	'  committing or to ask permission.',
	'- git commands (add / status / commit / log / diff) are VERSION CONTROL, NOT analysis',
	'  code: run them DIRECTLY in your shell. The "run code through Qoka tools, not the',
	'  terminal" rule is ONLY about analysis / scripts, never about git.',
	'- Do NOT `git push` or touch remotes - commits stay LOCAL. Never commit secrets,',
	'  credentials, or large data files (rely on .gitignore; never force-add ignored paths).',
	AUTO_COMMIT_END_MARKER,
	'',
].join('\n');

/** Write `text` atomically (tmp + rename) so a concurrent reader never sees half a file. */
function atomicWrite(file: string, text: string): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const tmp = `${file}.tmp`;
	fs.writeFileSync(tmp, text, 'utf8');
	fs.renameSync(tmp, file);
}

/**
 * Put the auto-commit block into Qoka's user-level CLAUDE.md and AGENTS.md: insert it if
 * absent, refresh it in place if an older wording is there. Everything else in those files
 * (e.g. the Qoka routing block aria-skills keeps in AGENTS.md) is left as it is.
 * Idempotent and best-effort - never throws.
 */
export function ensureQokaAutoCommitInstructions(): void {
	for (const file of QOKA_INSTRUCTION_FILES) {
		try {
			let existing = '';
			try { existing = fs.readFileSync(file, 'utf8'); } catch { /* no file yet */ }
			const start = existing.indexOf(AUTO_COMMIT_MARKER);
			let next: string;
			if (start !== -1) {
				const end = existing.indexOf(AUTO_COMMIT_END_MARKER, start);
				if (end === -1) { continue; } // malformed block: leave the file alone
				next = existing.slice(0, start) + AUTO_COMMIT_BLOCK.replace(/\n$/, '') + existing.slice(end + AUTO_COMMIT_END_MARKER.length);
			} else if (existing.trim()) {
				next = `${existing.replace(/\s*$/, '')}\n\n${AUTO_COMMIT_BLOCK}`;
			} else {
				next = AUTO_COMMIT_BLOCK;
			}
			if (next !== existing) { atomicWrite(file, next); }
		} catch { /* best-effort */ }
	}
}

/**
 * Remove the auto-commit block an older Qoka (0.4.18) appended to the PROJECT's CLAUDE.md /
 * AGENTS.md. Only the marker-delimited block is removed - the user's own content around it
 * is kept. A file that held nothing but Qoka's block (the header Qoka created it with, plus
 * the block) is deleted, since Qoka created it. Malformed or marker-less files are left
 * untouched. Best-effort - never throws.
 */
export function removeLegacyProjectAutoCommitBlocks(folder: string): void {
	for (const name of ['CLAUDE.md', 'AGENTS.md']) {
		try {
			const file = path.join(folder, name);
			if (!fs.existsSync(file)) { continue; }
			const current = fs.readFileSync(file, 'utf8');
			const start = current.indexOf(AUTO_COMMIT_MARKER);
			if (start === -1) { continue; }
			const end = current.indexOf(AUTO_COMMIT_END_MARKER, start);
			if (end === -1) { continue; }
			const before = current.slice(0, start).replace(/\s+$/, '');
			const after = current.slice(end + AUTO_COMMIT_END_MARKER.length).replace(/^\s+/, '');
			const remaining = [before, after].filter(s => s.length > 0).join('\n\n');
			if (remaining.trim() === '' || remaining.trim() === LEGACY_PROJECT_HEADER) {
				fs.unlinkSync(file);
			} else {
				fs.writeFileSync(file, remaining.endsWith('\n') ? remaining : `${remaining}\n`, 'utf8');
			}
		} catch { /* best-effort */ }
	}
}
