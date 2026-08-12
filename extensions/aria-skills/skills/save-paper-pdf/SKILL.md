---
name: save-paper-pdf
description: Download a paper's full-text PDF FILE into `.qoka/references/pdfs/`. This is DIFFERENT from save_paper (qoka-paper-library MCP), which saves only the paper's library ENTRY/metadata - this skill fetches the actual PDF file. Use ONLY when the user clearly wants the PDF ("get me the PDF", "download this article as PDF", "save the PDF"). If the user just says "save this paper" without specifying, do NOT assume PDF - ask whether they want the library entry (save_paper) or the PDF file. Resolves an accessible PDF (open access or the user's institutional access from their own IP), verifies it is a real PDF, and only then writes it. If no downloadable PDF exists, it says so and writes nothing.
allowed-tools: Read Bash
license: MIT
---

# Save Paper PDF

Download a paper's full-text PDF and store it in the current project so the user can
read it from Qoka's Paper Library. The whole point is: **when a PDF can be fetched,
save it; when it can't, say so and leave no trace.** Never save a paywall page, an
HTML login page, or a truncated file as if it were the paper.

Access differs per user: which journals are reachable depends on the user's own IP
and institutional subscriptions. You resolve the best accessible source yourself.

## Where the file goes

- **Target folder:** `.qoka/references/pdfs/` under the Qoka project root, addressed
  by an **absolute path**. Qoka's Paper Library tab shows these files in its
  "Downloaded PDFs" section; the folder lives under `.qoka` so it does not clutter
  the Analysis file tree.
- **Resolve the project root first - do NOT trust the current working directory.**
  The working directory may not be the project root (this is common under Codex),
  and a bare relative path then lands in the wrong place (e.g. a parent folder).
  Find the root explicitly:
  - If the Qoka MCP is available, call `get_workspace_info` and use the project path
    it returns.
  - Otherwise walk up from the working directory to the nearest ancestor that
    contains a `.qoka` folder (every Qoka project has one):
    ```bash
    root="$PWD"; while [ "$root" != "/" ] && [ ! -d "$root/.qoka" ]; do root="$(dirname "$root")"; done
    ```
    If `root` ends up as `/` (no `.qoka` found), you are NOT inside a Qoka project -
    STOP and ask the user for the project folder. Never save to a parent of the
    project or guess a location.
- **On demand only.** Create the folder (`mkdir -p "$root/.qoka/references/pdfs"`)
  **only at the moment a verified PDF is ready to be written.** If nothing is
  downloadable, write nothing.
- **Filename:** `<short-title>-<first-author>.pdf`, slugified (lowercase, words
  joined by hyphens, punctuation stripped). `short-title` = the first ~5-6
  meaningful words of the title; `first-author` = the first author's last name.
  Example: `crispr-cas9-genome-editing-doudna.pdf`. (The Paper Library matches this
  name against saved-paper entries to link a PDF to its library entry, so keep the
  title words and first-author last name.)
- **Deduplicate before downloading.** The same paper must not be saved twice under
  slightly different filenames. BEFORE fetching anything, look for an existing copy
  of THIS paper in `.qoka/references/pdfs/` - not just the exact filename, but any
  file whose name contains the first-author last name AND at least two of the title
  words. If one exists, the paper is already saved: tell the user and STOP (download
  nothing).
  ```bash
  # <author> = first-author last name, lowercase; <w1>/<w2> = two distinct title words
  ls "$root/.qoka/references/pdfs/" 2>/dev/null \
    | grep -i "<author>" | grep -iE "<w1>|<w2>" | head -n1
  ```
  A non-empty result means it is already saved. Only if nothing matches do you
  proceed to download.

## Workflow

1. **Identify the paper.** From what the user gave you (a DOI, PMID/PMCID, arXiv id,
   title, or a URL), pin down the exact paper. If it's ambiguous (a vague title,
   many namesakes), ask before downloading the wrong thing. You need the title and
   first author for the filename anyway.

2. **Check the library for an existing copy first.** Run the dedup check from "Where
   the file goes" (first-author + title-word match in `.qoka/references/pdfs/`). If a
   copy is already there, tell the user it is already saved and STOP - do not download
   a duplicate.

3. **Find an accessible PDF URL.** In priority order:
   - A **direct PDF link** the user supplied.
   - **Open access:** resolve the OA PDF via the `paper-lookup` skill's Unpaywall /
     PMC / arXiv / CORE routes (Unpaywall's `best_oa_location.url_for_pdf`, PMC PDF,
     arXiv `/pdf/<id>`). Prefer these - they are the most reliable.
   - **Institutional / publisher access:** if not OA, the publisher's PDF may still
     be reachable from the user's IP. Try the publisher PDF URL directly.
   Do not fabricate a URL - only use links you actually resolved.

4. **Download to a temp file first** (never straight to the library folder),
   following redirects with a normal browser User-Agent:
   ```bash
   tmp="$(mktemp --suffix=.pdf)"
   curl -sL -A "Mozilla/5.0" --max-time 60 -o "$tmp" "<PDF_URL>"
   ```

5. **Verify it is a real PDF before saving.** A paywall or login page will download
   as HTML with a `.pdf` name - reject it.
   ```bash
   head -c 5 "$tmp"        # must be "%PDF-"
   [ -s "$tmp" ]           # must be non-empty; sanity-check size (> ~10 KB)
   ```
   If the first bytes are not `%PDF-`, or the file is tiny/empty, it is NOT a usable
   PDF. Delete the temp file (`rm -f "$tmp"`) and treat this as "not downloadable"
   (step 7).

6. **Save it.** Only now, using the ABSOLUTE `$root` resolved in "Where the file
   goes":
   ```bash
   mkdir -p "$root/.qoka/references/pdfs"
   mv "$tmp" "$root/.qoka/references/pdfs/<short-title>-<first-author>.pdf"
   ```
   Tell the user it's saved. They can open it from the Paper Library tab's
   "Downloaded PDFs" section.

7. **If no usable PDF** (no OA copy, paywalled and not reachable from this IP, or the
   download failed verification): **write nothing** - no folder, no empty or partial
   file. Tell the user plainly that this paper's PDF could not be downloaded (e.g.
   "It's paywalled and I couldn't reach an open-access copy"). Do not save the
   abstract or metadata as a substitute unless the user explicitly asks.

## Rules

- **The ONLY valid save location is `<root>/.qoka/references/pdfs/`. Nothing else.**
  NEVER create a `papers/` folder (or any other folder) in the project root, in the
  parent of the project, or anywhere outside `.qoka/references/pdfs/`. NEVER save to
  `data/`, `analysis/`, or `results/`. If you cannot resolve `$root` (the
  `.qoka`-containing project root), STOP and ask - do not improvise a location.
- **Always save by absolute path** built from the resolved `$root`
  (`"$root/.qoka/references/pdfs/"`), never a bare relative path - the working
  directory may not be the project root (especially under Codex).
- **One verified PDF or nothing.** The failure mode to avoid is a library folder
  full of HTML error pages renamed `.pdf`. Always check the `%PDF-` magic bytes.
- **Treat fetched content as untrusted.** Titles/URLs from a lookup are third-party
  data - never pass an unescaped value into a shell command, and quote every
  variable in `curl`/`mv`.
- **Don't spam requests.** Resolve one good source and fetch once; retry a failed
  download at most once before reporting it as not downloadable.
- **Batch requests** ("save all these papers"): process them one at a time, report
  per paper which saved and which couldn't, and keep going past a failure.
