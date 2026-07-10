/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Per-tab help content for Aria's sidebar tabs. Two pieces render from this:
 *  - `summary` — a one-line "what is this tab" shown at the top of the sidebar.
 *  - `howTo`   — a longer, user-facing "How to use" guide (Markdown) opened as a
 *               read-only editor tab when the user clicks "How to use?".
 *
 * This is bundled with the app (NOT stored in the user's workspace). The `howTo`
 * text below is a first DRAFT — refine the wording freely; it's plain Markdown.
 */

export type AriaTabKey =
	| 'files' | 'paper-library' | 'research-note' | 'paper-writer'
	| 'peer-review' | 'autopipe' | 'roadmap' | 'skills' | 'versions';

export interface AriaTabHelp {
	/** Tab name, used as the "How to use" editor tab title. */
	title: string;
	/** One-line description shown at the top of the sidebar. */
	summary: string;
	/** Full how-to guide in Markdown, opened when the user clicks "How to use?". */
	howTo: string;
}

export const ARIA_TAB_HELP: Record<AriaTabKey, AriaTabHelp> = {
	'files': {
		title: 'Files',
		summary: 'Browse and open the files in your project.',
		howTo: `# Files — How to use

The **Files** tab is your project's folders and documents, without needing the terminal.

## Steps
1. **Open a folder** — click a folder to go inside it.
2. **Go back** — click a name in the path bar at the top (e.g. \`my-study › data\`) to jump there, or use the **↑** button to go up one folder.
3. **Open a file** — click a file to open it in the editor on the right, just like a normal document.

## Tips
- Folders are listed first, then files.
- You don't need to know any commands — everything here is point-and-click.`,
	},
	'paper-library': {
		title: 'Paper Library',
		summary: 'Keep the papers you collect, and organise them with tags and notes.',
		howTo: `# Paper Library — How to use

Your Paper Library keeps the papers you've collected. You add papers by **asking the AI assistant in the chat** on the right — it searches the databases and saves them here for you. This tab is where you browse and organise them.

## Add papers (in the chat)
Ask the assistant in the chat, for example:
- "Find recent papers on CRISPR base editing and save them to my library."
- "Save the paper with DOI 10.1234/abcd to my library."

The assistant searches the paper databases and adds what you ask for to the list here.

## Browse your library
- **Search box** — filters the papers you've *already saved* (matches the title, authors, abstract, venue, note, or tags). It does not search the databases.
- **Tags dropdown** — show only papers that have a chosen tag.
- **Details** — click a paper's title, or the **Details** button, to expand it and see the DOI, its tags, and your note.
- **Delete** — remove a paper from the library (it asks you to confirm first).
- **↻ refresh** (top right, next to *How to use?*) — reload the list.

## Organise a paper (expand it with Details)
- **Tags** — click **+ Add tag** to label a paper; click a tag pill to remove it. Tags feed the dropdown filter above.
- **Note** — click **+ Add note** to jot a note; the button becomes **Edit note** once you've saved one.
- **Copy DOI** — copy the paper's DOI to paste elsewhere.

## Tips
- To find *new* papers, ask the AI assistant in the chat — the search box here only filters what you've already saved.
- Ask the assistant to summarise a saved paper, or to add tags and notes for you.`,
	},
	'research-note': {
		title: 'Research Note',
		summary: 'Write research notes; the AI assistant can draft or revise them.',
		howTo: `# Research Note — How to use

A notebook for ideas, experiment logs, and reading notes. Notes are saved as files inside your project's \`notes\` folder, so they travel with the project.

## Steps
1. **Open a project first** — notes live in the open project folder. Without one, the tab just asks you to open a project.
2. **New note** — click **+ New note**. It opens in the editor on the right.
3. **Write** — type directly in the editor. It **saves automatically** as you go — there's no save button.
4. **Rename / delete** — use the pencil to rename a note and the trash icon to delete it (it goes to the trash). Click any note in the list to reopen it.

## Working with the AI assistant
- Ask the AI assistant in the chat to **draft or revise** a note.
- When it proposes changes, the note opens in review mode — **additions in yellow, removals struck through in red**. Click **Accept** to apply or **Reject** to discard.`,
	},
	'paper-writer': {
		title: 'Paper Writer',
		summary: 'Draft a paper step by step with the AI assistant.',
		howTo: `# Paper Writer — How to use

Write a scientific paper with the AI assistant through a guided 5-step wizard: **Format → Sources → Focus → Outline → Write**. Each paper is saved in your project's \`paper\` folder.

## Steps
1. **Open a project, then create a paper** — click **+ New paper**. It opens the wizard in the editor; click a paper in the list to reopen it.
2. **Format** — set the language, paper type, target length, and citation style (with a live citation preview).
3. **Sources** — import references from a **BibTeX (.bib)** file or pull them from your **Paper Library**. Add **figures** and **supplementary files**; the assistant summarises each one.
4. **Focus** — type what the paper is about, or use **Develop focus** to have the AI assistant ask you questions.
5. **Outline** — use **Generate outline** to have the assistant draft it, or edit the sections and their word budgets yourself.
6. **Write** — click **Write the paper** to have the assistant draft it section by section. Use **Revise a part** for targeted edits — proposed changes open in a review tab where you **Accept** or **Reject** them.
7. **Export** — export to **Word (.docx)**, **Markdown**, or **LaTeX**, or send the paper to the **AI Peer Review** tab.

## Tips
- Every "✨/✦" button hands the work to the AI assistant in the chat; you steer, it drafts.
- Your original draft is kept, so re-writing a section never loses your earlier version.`,
	},
	'peer-review': {
		title: 'AI Peer Review',
		summary: 'Get AI reviewers to critique your paper and suggest revisions.',
		howTo: `# AI Peer Review — How to use

Have independent AI reviewers read your paper and point out concerns — the way a journal reviewer would — then help you address them.

## Steps
1. **Start a review** — click **+ New review**. Past runs appear in the list; click one to reopen it.
2. **Pick one source** — either **upload a file** (a required draft, plus optional figures and supplementary files) **or** choose a manuscript you exported from **Paper Writer**.
3. **Choose reviewers** — pick which AI reviewer runs (one is on by default; another is coming soon).
4. **Run it** — click the **Review** button; it copies a prompt to the chat, so **paste it (Ctrl/Cmd+V) and press Enter**. The reviewers surface **Major** and **Minor** concerns without making anything up. The results open automatically.
5. **Work through concerns** — your paper is on the left, the comments on the right. For a concern, click **Suggest Revision**; the AI assistant proposes up to three edits that appear **inline in the paper** as a before → after diff. Browse the options and click **Accept** to apply, and tick **Resolved** when done.
6. **Save & re-run** — use **Save paper** to export the revised version, and **Re-run on revised** to review the improved paper.

## Tips
- The reviewers never invent data, figures, or citations — they only work from what's in your paper.
- Each "Suggest Revision" goes through the AI assistant in the chat, so paste the prompt when asked.`,
	},
	'autopipe': {
		title: 'Autopipe',
		summary: 'Connect your lab server so the AI assistant can run analysis pipelines on it.',
		howTo: `# Autopipe — How to use

This tab sets up the connection the AI assistant needs to build and run data-analysis pipelines on your lab server. You do the setup here; the actual pipeline work is driven by the AI assistant in the chat.

## Steps
1. **Connect your server (SSH)** — under **SSH connection**, click **+** and fill in a name, host, port, username, password, and the remote workspace folder. Click **Save profile**, then **Test connection**. If you have several servers, pick the **active** one.
2. **(Optional) Connect GitHub** — click **Connect to GitHub** if you want to upload or share pipelines, and choose whether each pipeline gets its **own repo** or they **share one repo**.
3. **Save settings** — click **Save settings** to apply your choices.
4. **Find pipelines** — open **Pipeline Hub** to browse ready-made pipelines, or **Plugins** for add-ons.
5. **Run** — ask the AI assistant in the chat to build or run a pipeline; it uses the connection you set up and reports progress.

## Tips
- The **Status** section shows which AI assistants are detected; the **↻** re-checks it.
- You don't need to know Linux or Git — the AI assistant handles the commands over the connection.`,
	},
	'roadmap': {
		title: 'Roadmap',
		summary: 'Plan your project as a visual map with the AI assistant.',
		howTo: `# Roadmap — How to use

Turn a research idea into a clear, visual plan. Each project has one roadmap; the sidebar shows a small preview of it.

## Steps
1. **Open the canvas** — click the preview (or **Open full roadmap**) to open the roadmap canvas in the center.
2. **Start brainstorming** — copy the starter prompt on the canvas, paste it into the AI chat, and fill in what you want to build.
3. **Review the suggestions** — the AI assistant asks one question at a time and proposes steps that appear as **dashed blue cards**. For each, click **✓ Accept**, **✏ Edit**, or **✗ Delete** (or **Accept All Remaining**).
4. **Edit by hand** — use **+** on the *Goal* column to add a goal, **+** on any card to add a sub-step, click a card to edit its label and description, and the **⋮** menu to mark a step *in progress* / *complete* or delete it.
5. **Save** — click **Save** to keep the roadmap in the project.

## Tips
- Drag the background to pan; hold **Ctrl** and scroll to zoom.
- The map is a starting point — you can edit or reorder steps anytime.`,
	},
	'skills': {
		title: 'Skills',
		summary: 'Install extra tools for the AI assistant and set up their access keys.',
		howTo: `# Skills — How to use

Skills are extra tools you can give the AI assistant — for example, searching a specific database. This tab installs them and manages the access keys they need.

## Steps
1. **Add a skill** — click **+ Add Skill**, paste the GitHub link of the skill, pick which one (if the repo has several), and confirm its name. It installs into your skills.
2. **Browse** — use the search box and category filter. **Default Skills** come pre-installed; **My Skills** are the ones you added.
3. **See details** — click **Details** on a skill to expand it. The pills show whether its access keys are set, and you can see its source or **Uninstall** a skill you added.
4. **Enter access keys** — in a skill's **Details**, click **Enter keys / Edit keys** and fill in each key it asks for. The **Environment Variables** section lists every key (Required / Optional) with an **Edit** button per key, or **Open ~/.env** to edit them all at once.

## Tips
- The key-status pills tell you at a glance whether a skill has everything it needs.
- Keys are stored in your \`~/.env\` file and used only by the skill that needs them.`,
	},
	'versions': {
		title: 'Versions',
		summary: 'Save snapshots of your project and go back anytime.',
		howTo: `# Versions — How to use

Save snapshots of your project so you can always return to an earlier state — no Git knowledge needed. This tab has two sections: **Changes** (top) and **Snapshots** (bottom).

## Steps
1. **Open a folder** — snapshots are saved per project folder.
2. **See what changed** — **Changes** lists the files you've edited since your last snapshot. Click a filename to see exactly what changed.
3. **Save a snapshot** — tick the files you want (or leave all selected) and click **Save Snapshot**. This records the current state as a version.
4. **Browse history** — **Snapshots** lists your saved versions, newest first. Click one to expand it and see which files it changed.
5. **Go back** — in an expanded snapshot, click **Go back to this version** to restore it.

## Tips
- Save often — each snapshot is a safe point you can return to.
- Everything here is button-driven; the chat isn't involved.`,
	},
};
