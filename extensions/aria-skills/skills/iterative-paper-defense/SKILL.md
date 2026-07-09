---
name: iterative-paper-defense
description: Automated AI peer review with iterative, defensive revision of a scientific manuscript. Runs multiple independent reviewer sub-agents (diverse lenses) to surface Major/Minor Concerns, records them for Aria's Peer Review tab, then optionally defends the paper with minimal, non-fabricated edits. Use when the user asks to peer-review / critique / defend a paper, or when Aria's Peer Review tab starts a review (it passes an `execId`).
---

# Iterative Paper Defense (AI Peer Review)

Automate rigorous peer review of a manuscript and, when asked, iteratively defend
it — reframing scope/logic without ever fabricating results. This runs inside
Aria: reviewers are **Claude sub-agents you spawn in parallel** (via the Agent /
Task tool), and results are recorded through Aria's paper-review MCP tools so the
**Peer Review tab** renders them. There is no `wdiff`, no `sudo`, and no external
diff file — Aria's UI computes and shows the diff.

## When Aria starts a review

Aria's Peer Review tab creates a review and sends you a prompt containing an
`execId`. Your job:

1. **Load the paper.** Call `get_review(execId)`. It returns the **`manuscript`**
   (`{ name, text }` — the MAIN text to review), any **`supplementary`** documents
   (`[{ name, text }]` — extra data/context), the **`figures`** (filenames only —
   you can't see the images), the title, and the reviewers to use (e.g.
   `["claude"]`). Review the **manuscript**; use supplementary material as evidence
   to check the manuscript's claims against.
2. **Run reviewers in parallel** (see below).
3. **Record concerns** with `record_review(...)` for each reviewer.
4. Tell the user the review is ready in the Peer Review tab. Do NOT dump the full
   concern list into the chat — the tab shows it.

If there is no `execId` (the user just pasted a paper or asked ad hoc), do the
same review but summarize the concerns in chat.

## Reviewers = parallel Claude sub-agents

For each reviewer requested (MVP: `claude`), spawn **independent sub-agents in
one batch** (a single message with multiple Agent tool calls) so they run
concurrently. Give each a **distinct lens** so they don't all find the same
thing:

- **methodology / statistics** — study design, sample size, controls, stats, p-values, multiple-comparison handling.
- **scope / framing / novelty** — over-claiming, generalization beyond the data, missing baselines, contribution vs prior work.
- **reproducibility / rigor** — can the results be reproduced from what's written; are procedures, versions, and data fully specified.

Each sub-agent receives the manuscript text + supplementary and the **calibration
rule** below, and returns Major and Minor Concerns as structured items.

Aggregate across sub-agents into ONE reviewer result per reviewer id (dedupe
near-duplicates; keep the clearest phrasing). Then call `record_review`.

### Calibration rule (what counts as a concern)

> A "Major Concern" must be a concrete, named methodological, statistical, or
> scoping flaw that genuinely prevents acceptance. Vague calls for "more datasets",
> "more baselines", "more validation", or generic "the claim is too strong"
> complaints do **NOT** count as major if the manuscript already gives an explicit,
> defensible justification for the chosen scope. If the manuscript already
> addresses a potential concern with an explicit reasoned justification (even if
> you would have preferred more), that concern is at most **Minor**. Do not invent
> missing analyses the authors were not required to perform — judge what is in the
> paper. If there are no genuine major concerns, it is correct to report **zero**.

Give each reviewer sub-agent this shape (it mirrors the calibrated reviewer prompt
this skill is adapted from): produce a short **Summary**, a numbered **Major
Concerns** list (or the single line "NONE"), a numbered **Minor Concerns** list,
and a one-word **Verdict** (Accept / Minor Revision / Major Revision / Reject).
Then map those into the `{severity, title, detail}` concern objects for
`record_review`.

Each concern is an object:
`{ severity: "major" | "minor", title: "<one-line>", detail: "<specific, quotes the manuscript where possible, says why it matters and what would fix it>" }`

## Recording results

Call once per reviewer:

```
record_review(execId, reviewer="claude", concerns=[ {severity, title, detail}, ... ])
```

`record_review` stores the concerns for that reviewer and iteration; Aria's tab
groups them into Major / Minor and shows a per-reviewer tab with counts (e.g.
"Claude (9)").

## Suggesting a revision (when the user clicks "Suggest Revision")

The Peer Review tab shows a **Suggest Revision** button under each concern. When
the user clicks it you get a prompt with an `execId` and a `concernId`. Propose a
single, concrete edit that resolves **that one** concern:

1. **Read the current paper** with `get_review(execId)` (it returns the working
   copy if earlier revisions were accepted).
2. **Devise up to 3 alternative counter-justification strategies** for the concern
   (do NOT pick just one — the user chooses). State each as:
   - **Argument** — the reasoning, in a single sentence.
   - **Edit footprint** — the affected location and approximate word count.
   - **Risk** — what must be true for it to hold, and what reverts if verification
     fails.

   Each strategy is a real edit. A valid edit only **adds reasoning, scoping, or
   framing about choices already present** — it defends what IS there, it never
   invents what is not. **Prefer adding a clause over inserting a whole sentence**;
   keep everything else byte-identical. Strategies may edit different spans.
3. **Fact-check every strategy**: internal claims must trace to the original
   manuscript; external claims must check out against authoritative sources (e.g.
   the bioRxiv / PubMed MCP tools). Drop any strategy that can't be verified —
   never fabricate.
4. **Record them together in ONE call** (up to 3 proposals):

   ```
   record_revision(execId, concernId, documentKey, proposals=[
     { original, replacement, explanation },   // strategy 1
     { original, replacement, explanation },   // strategy 2 (optional)
     { original, replacement, explanation },   // strategy 3 (optional)
   ])
   ```

   `documentKey` is the document you're editing — `"main"` for the manuscript
   (default) or a supplementary key like `"suppl-1"` from `get_review` (most fixes
   are in the manuscript, but a fix can belong in a supplementary document). For
   each proposal: `original` is the EXACT span to replace (verbatim, long enough to
   be unique) from THAT document, `replacement` is the full new text, `explanation`
   states the strategy's argument (and any risk) in one or two sentences.

Aria shows the strategies inline in the paper as a **"< N/3 >" carousel**; the user
browses them and clicks **Accept** on the one they want, which applies that span and
marks the concern resolved. They can then **Re-run** the review on the revised paper.
Record one `record_revision` call per concern the user asks about.

## Ad-hoc edits (user asks to change a review document directly)

When the user asks you to edit a document **directly** — not to resolve a review
concern (e.g. "delete the title in the supplementary", "fix this typo in suppl-1")
— use **`propose_document_edit(execId, documentKey, proposals)`**. It does NOT change
anything immediately: Aria shows the edit inline in that document (auto-switching to
its tab) with an **Accept** button, and applies it only when the user accepts. Give
1–3 alternative `proposals` (each `{ original, replacement, explanation }`); set
`replacement` to `""` to delete a span. `documentKey` is `"main"` or a supplementary
key like `"suppl-1"`.

> **Which tool? (don't confuse with Paper Writer.)** In a review (you were given an
> `execId`), edit the review's documents with `propose_document_edit` (ad-hoc) or
> `record_revision` (concern-tied) — these operate on the review's own working copies
> under `reviews/<execId>/`. Do **NOT** use Paper Writer tools (`set_manuscript`,
> `propose_manuscript_revision`, …) here: those edit a different store (the Paper
> Writer manuscript) and would not show up in the review. A review is an isolated
> sandbox; the user exports the result with **Save paper**.

Concerns can also be **about a supplementary document** (e.g. incomplete
supplementary methods). Record them in the reviewer's concern list as usual; when
you then propose a fix, set `documentKey` to that supplementary so the revision
lands in the right document.

## Core constraint — NEVER fabricate

Prohibited additions (revert on fact-check if present):

- Numbers, statistics, p-values, or effect sizes not in the source (unless trivially derivable from stated values).
- References to supplementary figures/tables that do not already exist.
- Procedures the authors did not perform (blinded annotators, extra reruns, additional benchmarks, new seeds).
- Hyperparameters, versions, or settings not stated in the source.
- Claims that data/seeds/code were released, or that AI was/ wasn't used, unless the source says so.

A defense reframes or clarifies what IS there; it never invents what is not.

## Output language

Write concern titles/details and any revision in the paper's configured language
when known; otherwise match the manuscript's language.
