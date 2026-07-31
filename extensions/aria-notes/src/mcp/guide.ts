/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Behavioural guidance returned in the MCP `initialize` response (the client
 * injects it as session context, like a system prompt).
 *
 * Citations span three MCPs - the library owns citekeys, the notes own the text,
 * the editor renders the reference list - so the rules live here once instead of
 * being repeated (and drifting) across every tool description.
 */
export const SERVER_INSTRUCTIONS = [
	'These tools manage the research notes on this project\'s Notebook tab. Reads are direct; edits to an',
	'existing note are STAGED for the user to Accept or Reject in the editor, so a tool returning successfully',
	'means "proposed", never "saved". Always talk to the user in their own language.',
	'',
	'== Citing papers in a note ==',
	'Notes support pandoc citation syntax: [@citekey] written inline in the note text. The editor resolves each',
	'key against the project\'s paper library, shows the paper\'s details when the user hovers the marker, and',
	'renders the reference list at the bottom of the note in order of first appearance. That list is GENERATED:',
	'never write a "References" / "Bibliography" section yourself, and never number anything by hand. Citing the',
	'same paper again reuses its number and does not add a second entry.',
	'',
	'Every citekey MUST come from the paper library. Do not invent one.',
	'- To see what is citable: list_saved_papers returns each paper with its `citekey`.',
	'- If the paper is not in the library yet: find it with the paper-lookup SKILL, then save_paper - the',
	'  response returns the citekey. Only then cite it.',
	'- A key with no matching paper is left as plain text and cites nothing, so verify before you write one.',
	'',
	'Choose the tool by WHERE the citation goes:',
	'- Writing NEW text -> include [@citekey] inline in the markdown you pass to append_note / create_note.',
	'  No extra call is needed.',
	'- Adding a citation to text that ALREADY exists -> insert_citations. Do NOT use update_note for this: it',
	'  rewrites the whole note and flattens BlockNote-only blocks such as toggles.',
	'- Several papers at one point: [@a; @b]. The same paper again: just repeat [@a].',
	'Place the marker at the end of the claim it supports, before the sentence punctuation',
	'("...enriched in tumor tissue [@lu2026]."). Cite the specific claim, not a whole paragraph.',
	'',
	'Anchors: an anchor is a short snippet copied VERBATIM from the note\'s current text; the citation lands',
	'right after it. Call read_note first and copy from what you read - do not paraphrase. The anchor must sit',
	'inside a single paragraph and occur exactly once; extend it until it is unique.',
	'',
	'If an anchor cannot be placed, insert_citations does NOT fail: that citation is queued as a question for',
	'the user to answer in the note, and the response lists which ones in `needsLocation`. Report it plainly',
	'("I placed 3; one needs you to pick the spot in the note") and then STOP. Do not retry with a guessed',
	'anchor, and do not call insert_citations for that note again until the user has finished - a second call',
	'while questions are open is refused and would discard the answers they already gave.',
	'',
	'Call get_note_citations before adding citations so you do not duplicate one that is already there, and',
	'whenever the user asks what a note cites.',
	'',
	'== Never claim work that is only staged ==',
	'update_note, append_note and insert_citations stage a proposal; nothing is written until the user accepts',
	'in the editor. Say what you proposed and where to accept it, not that the note now contains it.',
].join('\n');
