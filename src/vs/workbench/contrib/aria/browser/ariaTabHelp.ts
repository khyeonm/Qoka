/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Per-tab help content for Qoka's sidebar tabs. Two pieces render from this:
 *  - `summary` - a one-line "what is this tab" shown at the top of the sidebar.
 *  - `howTo`   - a longer, user-facing "How to use" guide (Markdown) opened as a
 *               read-only editor tab when the user clicks "How to use?".
 *
 * This is bundled with the app (NOT stored in the user's workspace). The `howTo`
 * text below is a first DRAFT - refine the wording freely; it's plain Markdown.
 */

export type AriaTabKey =
	| 'files' | 'paper-library' | 'research-note' | 'paper-writer'
	| 'peer-review' | 'manuscript' | 'autopipe' | 'roadmap' | 'skills' | 'versions';

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
		howTo: `# Files - How to use

The **Files** tab is your project's folders and documents, without needing the terminal.

## Steps
1. **Open a folder** - click a folder to go inside it.
2. **Go back** - click a name in the path bar at the top (e.g. \`my-study › data\`) to jump there, or use the **↑** button to go up one folder.
3. **Open a file** - click a file to open it in the editor on the right, just like a normal document.

## Tips
- Folders are listed first, then files.
- You don't need to know any commands - everything here is point-and-click.`,
	},
	'paper-library': {
		title: 'Paper Library',
		summary: 'Keep the papers you collect, and organise them with tags and notes.',
		howTo: `# Paper Library - How to use

Your Paper Library keeps the papers you've collected. You add papers by **asking the AI assistant in the chat** on the right - it searches the databases and saves them here for you. This tab is where you browse and organise them.

## Add papers (in the chat)
Ask the assistant in the chat, for example:
- "Find recent papers on CRISPR base editing and save them to my library."
- "Save the paper with DOI 10.1234/abcd to my library."

The assistant searches the paper databases and adds what you ask for to the list here.

## Browse your library
- **Search box** - filters the papers you've *already saved* (matches the title, authors, abstract, venue, note, or tags). It does not search the databases.
- **Tags dropdown** - show only papers that have a chosen tag.
- **Details** - click a paper's title, or the **Details** button, to expand it and see the DOI, its tags, and your note.
- **Delete** - remove a paper from the library (it asks you to confirm first).
- **↻ Refresh** - at the right of the one-line description (just below *How to use?*) - reloads the list.

## Organise a paper (expand it with Details)
- **Tags** - click **+ Add tag** to label a paper; click a tag pill to remove it. Tags feed the dropdown filter above.
- **Note** - click **+ Add note** to jot a note; the button becomes **Edit note** once you've saved one.
- **Copy DOI** - copy the paper's DOI to paste elsewhere.

## Tips
- To find *new* papers, ask the AI assistant in the chat - the search box here only filters what you've already saved.
- Ask the assistant to summarise a saved paper, or to add tags and notes for you.`,
	},
	'research-note': {
		title: 'Research Note',
		summary: 'Write research notes; the AI assistant can draft or revise them.',
		howTo: `# Research Note - How to use

A notebook for ideas, experiment logs, and reading notes. Notes are saved as files inside your project's \`notes\` folder, so they travel with the project.

## Steps
1. **New note** - click **+ New note**. It opens in the editor on the right.
2. **Write** - type directly in the editor. It **saves automatically** as you go - there's no save button.
3. **Rename / delete** - use the pencil to rename a note and the trash icon to delete it (it goes to the trash). Click any note in the list to reopen it.

## Working with the AI assistant
- Ask the AI assistant in the chat to **draft or revise** a note.
- When it proposes changes, the note opens in review mode - **additions in yellow, removals struck through in red**. Click **Accept** to apply or **Reject** to discard.`,
	},
	'paper-writer': {
		title: 'Paper Writing',
		summary: 'Draft a paper step by step with the AI assistant.',
		howTo: `# Paper Writing - How to use

Write a scientific paper with the AI assistant, step by step: **Format → Sources → Focus → Outline → Write → Revise**. Each paper is saved in your project's \`paper\` folder. The AI buttons below don't act on their own - they **copy a prompt** that you paste to the AI assistant in the chat.

## Steps
1. **Open a project, then create a paper** - click **+ New paper**. It opens the wizard in the editor; click a paper in the list to reopen it.
2. **Format** - set the language, paper type, target length, and citation style (with a live citation preview).
3. **Sources** - import references from a **BibTeX (.bib)** file or pull them from your **Paper Library**. Add **figures** and **supplementary files**; the assistant summarises each one.
4. **Focus** - describe what the paper is about. Click **Develop focus** to **copy a prompt**; paste it to the AI assistant in the chat and it drafts the focus. You can then edit the result freely.
5. **Outline** - click **Generate outline** to **copy a prompt** for the AI assistant, or write the sections and their word budgets yourself. The result is fully editable.
6. **Write** - click **Write the paper** to **copy a prompt**; paste it to the AI assistant and it drafts the manuscript section by section. You can edit any text directly.
7. **Revise** - click **Revise a part** to **copy a prompt**; paste it, then tell the AI assistant what to change. It edits only that part (leaving the rest untouched) and opens the changes in a review tab where you **Accept** or **Reject** each one.
8. **Export** - export to **Word (.docx)**, **Markdown**, or **LaTeX**. The files land in your project's **paper** folder, where you can open and edit them freely.

## Tips
- Your original first draft is kept as \`paper/<id>/manuscript.original.md\` and stays there **unchanged even while you revise with the AI**, so you never lose your earlier version.`,
	},
	'manuscript': {
		title: 'Manuscript',
		summary: 'Write a paper with the AI, then hand it straight to an AI peer review.',
		howTo: `# Manuscript - How to use

The **Manuscript** tab is where you both **write** a paper and **review** it. Click **+ New** and choose **Paper writing** to draft a paper, or **Paper review** to critique one. The list below has a **Writing** section (your papers) and a **Reviews** section (your review runs); click any item to reopen it, or the trash icon to delete it.

## Write a paper
Choosing **Paper writing** opens the writing wizard: **Format → Sources → Focus → Outline → Write → Revise**. Each paper is saved under \`.qoka/manuscript/draft/\`. The AI buttons **copy a prompt** that you paste to the AI assistant in the chat; you can edit any result freely. (This is the same flow as the old Paper Writing tab - nothing was removed.)

## Hand off to review
On the last step, once the paper is drafted, click **Proceed to paper review →**. It opens a new review with **this paper already selected as the source** - whatever you last wrote or revised. You don't have to re-upload anything.

## Review a paper
Choosing **Paper review** (or arriving via the hand-off) opens the new-review form: pick **one source** (upload a file, or a paper you wrote here), choose the AI reviewer(s), then run them to surface **Major** and **Minor** concerns. For each concern, click **Suggest Revision** to get inline before → after edits you can **Accept**, tick **Resolved** when done, then **Save** / **Re-run on revised**. (This is the same flow as the old Peer Review tab.)

## Tips
- The **Proceed to paper review** button uses your current manuscript, so revise first, then hand off.
- A review needs an AI you've **signed in to** in its chat app; if a reviewer shows "CLI not installed", set up its provider in the **Settings** tab.`,
	},
	'peer-review': {
		title: 'Peer Review',
		summary: 'Get AI reviewers to critique your paper and suggest revisions.',
		howTo: `# Peer Review - How to use

Have independent AI reviewers read your paper and point out concerns - the way a journal reviewer would - then help you address them.

## Steps
1. **Start a review** - click **+ New review**. Past runs appear in the list; click one to reopen it.
2. **Pick one source** - either **upload a file** (a required draft, plus optional figures and supplementary files) **or** choose a manuscript you exported from **Paper Writing**.
3. **Choose reviewers** - pick which AI reviewer(s) run. You can only use an AI you've **signed in to in its chat app**.
4. **Run it** - click the **Review** button; it **copies a prompt**. Paste it (**Ctrl/Cmd+V**) into your AI assistant. The reviewer's **Major** and **Minor** concerns then appear in the editor.
5. **Work through concerns** - your paper is on the left, the comments on the right. For a concern, click **Suggest Revision**; the AI assistant proposes up to three edits that appear **inline in the paper** as a before → after diff. Browse the options and click **Accept** to apply, and tick **Resolved** when done.
6. **Save & re-run** - use **Save paper** to export the revised version, and **Re-run on revised** to review the improved paper.

## Tips
- You don't paste the prompt into every AI - paste it into **one** of the AI apps you picked in step 3.
- If a reviewer shows **"CLI not installed"**, click the **account info at the bottom** and choose an **AI provider** - Qoka then downloads its CLI. You also need to install that AI's **extension** and **sign in** to it before you can use it.`,
	},
	'autopipe': {
		title: 'Autopipe',
		summary: 'The AI assistant builds and runs your analysis pipelines and shows you the results.',
		howTo: `# Autopipe - How to use

The AI assistant **builds and runs** your data-analysis pipelines and **shows you the results** - you drive it all from the chat. The **Autopipe** section of the **Settings** tab is where you connect GitHub (to share pipelines) and find ready-made ones.

## Where it runs
You choose where pipelines run in the **Connections** section (just above Autopipe in Settings): the **built-in server** (default on Windows / Mac) or your own **SSH lab server**. The AI assistant then uses whichever one is active.

## Steps
1. **(Optional) Connect GitHub** - click **Connect to GitHub** to upload or share pipelines. A code and a button to open GitHub appear; enter the code there to finish. Once connected, the row shows your account and a **Sign out** button.
2. **Choose the upload mode** - under **Pipeline upload mode**, pick **Per-pipeline repo** (each pipeline gets its own GitHub repo) or **Single shared repo** (all pipelines share one repo - type its name in the field that appears).
3. **Find pipelines** - under **Discover**, open **Pipeline Hub** to browse ready-made pipelines, or **Plugins** for add-ons.
4. **Build & run** - ask the AI assistant in the chat to build or run a pipeline; it uses your active run environment, reports progress, and shows the results.

Your **GitHub** and **upload mode** choices are **saved automatically** the moment you change them - there's no Save button.

## Tips
- GitHub is only needed to **upload or share** pipelines - you can build and run them without it.
- You don't need to know Linux or Git - the AI assistant handles the commands.`,
	},
	'roadmap': {
		title: 'Roadmap',
		summary: 'Plan your project as a visual map with the AI assistant.',
		howTo: `# Roadmap - How to use

Turn a research idea into a clear, visual plan. Each project has one roadmap; the sidebar shows a small preview of it.

## Steps
1. **Open a roadmap** - in the **Roadmap** tab, pick a roadmap from the list to open it in the center.
2. **Start brainstorming** - copy the starter prompt on the canvas, paste it into the AI chat, and fill in what you want to build.
3. **Review the suggestions** - the AI assistant asks one question at a time and proposes steps that appear as **dashed blue cards**. For each, click **✓ Accept**, **✏ Edit**, or **✗ Delete** (or **Accept All Remaining**).
4. **Edit by hand** - use **+** on the *Goal* column to add a goal, **+** on any card to add a sub-step, click a card to edit its label and description, and the **⋮** menu to mark a step *in progress* / *complete* or delete it.

The roadmap **saves automatically** on every change (the header shows *✓ Saved automatically*) - there's no Save button.

## Ask about prior research & methods
While you brainstorm, the AI assistant can also help you ground each idea in real research:
- **Check prior research** - find whether similar studies already exist for a hypothesis you added. It searches a corpus of ~1M open-access research papers and shows which ones actually tested it and how.
- **Suggest methods** - see what experimental methods have been used to test a hypothesis like yours, so you can add the promising ones as steps.

The assistant offers these right after you add a hypothesis or goal - just say yes. You can also ask directly, e.g. *"has this been studied before?"* or *"what methods would test this?"*.

## Tips
- Drag the background to pan; hold **Ctrl** and scroll to zoom.
- The map is a starting point - you can edit or reorder steps anytime.`,
	},
	'skills': {
		title: 'Skills',
		summary: 'Install extra tools for the AI assistant and set up their access keys.',
		howTo: `# Skills - How to use

Skills are extra tools you can give the AI assistant - for example, searching a specific database. The **Skills** section of the **Settings** tab installs them and manages the access keys they need.

## Steps
1. **Add a skill** - click **+ Add** and paste the GitHub link of a repo that contains a \`SKILL.md\`. The AI reads it and automatically **names the skill, suggests a category, and tells you which environment variables it needs**, then installs it. You don't have to enter any keys to add it - set them afterward (below) when needed.
2. **Browse** - use the search box and the **category** filter next to it. Skills are grouped into **Default Skills** (pre-installed, with a nested **K-Dense** group) and **My Skills** (the ones you added). Click a group heading to collapse or expand it.
3. **See details** - click a skill's row to expand it in place. Inside you'll see its description, its **Category** (edit it with the pencil), and its keys split into **Required** and **Optional** columns. For a skill you added you can also open its **source** or **Uninstall** it.
4. **Set a key** - click the **pencil** next to any key (in a skill's details or in the **Environment Variables** section) to enter its value. Changes are **saved automatically to your \`~/.env\` file**. Click **Open ~/.env** to view the file's contents.

## Reading the key status
Each skill shows a small pill:
- **No key needed** - it works as-is.
- **keys set** - every key it needs has a value.
- **N required** / **N optional** - that many keys are still empty (red = required, yellow = optional).

## Tips
- Fill in the **Required** keys for a skill to work; Optional ones can be left blank.
- Keys live in your \`~/.env\` file and are used only by the skill that needs them.`,
	},
	'versions': {
		title: 'Versions',
		summary: 'Save snapshots of your project and go back anytime.',
		howTo: `# Versions - How to use

Save snapshots of your project so you can always return to an earlier state. This tab has two sections: **Changes** (top) and **Snapshots** (bottom).

## Steps
1. **See what changed** - **Changes** lists the files you've edited since your last snapshot. Click a filename to see exactly what changed.
2. **Save a snapshot** - tick the files you want (or leave all selected) and click **Save Snapshot**. The AI **suggests a name** and asks whether to **group it with your previous snapshot**. Adjust either as you like, then save - it records the current state as a version.
3. **Browse history** - **Snapshots** lists your saved versions, newest first. Click one to expand it and see which files it changed.
4. **Go back** - in an expanded snapshot, click **Go back to this version** to restore it.

## Tips
- Save often - each snapshot is a safe point you can return to.
- The AI only **suggests** a name - you can always type your own before saving.`,
	},
};
