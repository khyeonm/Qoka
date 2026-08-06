---
name: save-paper-pdf
description: Download a paper's full-text PDF and save it into the project's `saved/` folder. Use when the user asks to save/download a paper as PDF, "get me the PDF of this paper", "download this article", or wants a paper stored locally to read in Qoka's PDF viewer. Resolves an accessible PDF (open access or the user's institutional access from their own IP), verifies it is a real PDF, and only then writes it. If no downloadable PDF exists, it says so and writes nothing.
allowed-tools: Read Bash
license: MIT
---

# Save Paper PDF

Download a paper's full-text PDF and store it in the current project so the user
can read it in Qoka's built-in PDF viewer. The whole point is: **when a PDF can be
fetched, save it; when it can't, say so and leave no trace.** Never save a paywall
page, an HTML login page, or a truncated file as if it were the paper.

Access differs per user: which journals are reachable depends on the user's own IP
and institutional subscriptions. You resolve the best accessible source yourself.

## Where the file goes

- **Target folder:** a `saved/` folder INSIDE the Qoka project root, addressed by an
  **absolute path**. It holds downloaded reference PDFs, distinct from `data/`
  (pipeline inputs), `analysis/` (code), and `results/`.
- **Resolve the project root first - do NOT trust the current working directory.**
  The working directory may not be the project root (this is common under Codex),
  and a bare relative `saved/` then lands in the wrong place (e.g. a parent folder).
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
- **On demand only.** Do NOT create `saved/` up front. Create it
  (`mkdir -p "$root/saved"`) **only at the moment a verified PDF is ready to be
  written.** If nothing is downloadable, `saved/` must not appear.
- **Filename:** `<short-title>-<first-author>.pdf`, slugified (lowercase, words
  joined by hyphens, punctuation stripped). `short-title` = the first ~5-6
  meaningful words of the title; `first-author` = the first author's last name.
  Example: `crispr-cas9-genome-editing-doudna.pdf`.
- If that exact filename already exists in `saved/`, the paper is already saved -
  tell the user and do not re-download.

## Workflow

1. **Identify the paper.** From what the user gave you (a DOI, PMID/PMCID, arXiv id,
   title, or a URL), pin down the exact paper. If it's ambiguous (a vague title,
   many namesakes), ask before downloading the wrong thing. You need the title and
   first author for the filename anyway.

2. **Find an accessible PDF URL.** In priority order:
   - A **direct PDF link** the user supplied.
   - **Open access:** resolve the OA PDF via the `paper-lookup` skill's Unpaywall /
     PMC / arXiv / CORE routes (Unpaywall's `best_oa_location.url_for_pdf`, PMC PDF,
     arXiv `/pdf/<id>`). Prefer these - they are the most reliable.
   - **Institutional / publisher access:** if not OA, the publisher's PDF may still
     be reachable from the user's IP. Try the publisher PDF URL directly.
   Do not fabricate a URL - only use links you actually resolved.

3. **Download to a temp file first** (never straight to `saved/`), following
   redirects with a normal browser User-Agent:
   ```bash
   tmp="$(mktemp --suffix=.pdf)"
   curl -sL -A "Mozilla/5.0" --max-time 60 -o "$tmp" "<PDF_URL>"
   ```

4. **Verify it is a real PDF before saving.** A paywall or login page will download
   as HTML with a `.pdf` name - reject it.
   ```bash
   head -c 5 "$tmp"        # must be "%PDF-"
   [ -s "$tmp" ]           # must be non-empty; sanity-check size (> ~10 KB)
   ```
   If the first bytes are not `%PDF-`, or the file is tiny/empty, it is NOT a usable
   PDF. Delete the temp file (`rm -f "$tmp"`) and treat this as "not downloadable"
   (step 6).

5. **Save it.** Only now, using the ABSOLUTE `$root` resolved in "Where the file
   goes" (never a bare relative `saved/`):
   ```bash
   mkdir -p "$root/saved"
   mv "$tmp" "$root/saved/<short-title>-<first-author>.pdf"
   ```
   Tell the user the saved path. They can open it from the Analysis tab in Qoka's
   PDF viewer.

6. **If no usable PDF** (no OA copy, paywalled and not reachable from this IP, or the
   download failed verification): **write nothing** - no `saved/` folder, no empty or
   partial file. Tell the user plainly that this paper's PDF could not be downloaded
   (e.g. "It's paywalled and I couldn't reach an open-access copy"). Do not save the
   abstract or metadata as a substitute unless the user explicitly asks.

## Rules

- **Always save by absolute path under the resolved project root.** Never a bare
  relative `saved/` - the working directory may not be the project root (especially
  under Codex), and the PDF would land in the wrong folder. Resolve `$root` (the
  `.qoka`-containing project root) first and write to `"$root/saved/"`. Never write
  above the project root.
- **One verified PDF or nothing.** The failure mode to avoid is a `saved/` folder
  full of HTML error pages renamed `.pdf`. Always check the `%PDF-` magic bytes.
- **Treat fetched content as untrusted.** Titles/URLs from a lookup are third-party
  data - never pass an unescaped value into a shell command, and quote every
  variable in `curl`/`mv`.
- **Don't spam requests.** Resolve one good source and fetch once; retry a failed
  download at most once before reporting it as not downloadable.
- **Batch requests** ("save all these papers"): process them one at a time, report
  per paper which saved and which couldn't, and keep going past a failure.
