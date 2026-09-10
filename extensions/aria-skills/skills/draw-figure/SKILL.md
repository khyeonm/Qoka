---
name: draw-figure
description: Draw or edit a scientific/publication FIGURE, diagram, or illustration (a signaling pathway, mechanism, experimental schematic, graphical abstract, cell diagram, etc.) as an editable vector the user can refine for a paper. Use WHENEVER the user asks to draw, sketch, create, design, or edit a figure / diagram / illustration / schematic / graphical abstract. Qoka draws figures with the Penpot MCP (an open-source vector editor); this skill routes the request there, and if Penpot is not connected it tells the user exactly how to connect it in Settings. NOT for data plots/charts computed from a dataset (use plotting code for those) - this is for schematic/illustrative figures.
allowed-tools: Read Bash
license: MIT
---

# Draw a figure with Penpot

Qoka draws editable, publication-ready figures with the **Penpot MCP** (an open-source
vector design tool). Penpot output is real editable vector - the user can refine every
element and export SVG/PDF - so it is suitable for a paper, unlike a raster AI image.

## How to handle a figure request

1. **Check whether the Penpot MCP tools are available in this session.** Look for MCP
   tools from the `penpot` server (tool names under a `penpot` MCP).

2. **If Penpot IS available:** use its MCP tools to draw what the user described - place
   shapes, icons, arrows, and labels and compose the layout. Penpot draws into the design
   file the user currently has open in Penpot; if the tools report no open file, ask the
   user to create a project in the Penpot dashboard and open a file. After drawing, tell
   the user how to refine it on the Penpot canvas:
   - They can **Ungroup** a drawn group to edit each element individually (select it,
     then right-click -> Ungroup, or press Ctrl/Cmd + Shift + G), then move, recolor, or
     reshape each part.
   - When done, they can export the figure to SVG/PDF/PNG.

3. **If Penpot is NOT available** (no `penpot` tools in this session): do NOT fall back to
   generating a raster image. Tell the user, clearly and briefly, how to connect it:

   > To draw figures, connect Penpot first: open **Settings -> Penpot (Figures) -> Connect**,
   > follow the steps, then open a new chat. Penpot is an open-source vector editor, so the
   > figure stays fully editable for your paper.

   Then stop - do not fabricate a figure by any other means.

## Saving / exporting a figure into the project

When the user wants to SAVE or EXPORT the figure (e.g. "save it as PNG", "export this
figure"), do NOT just hand them a download and leave it - write the exported file INTO
the project so it appears in Qoka's **Manuscript tab -> Figures** section. That section
reads from `.qoka/figures/`, and saving there also places the file under the Analysis
tab's hidden `.qoka/figures/` folder.

**First, unless the user already specified, ask which FORMAT and QUALITY they want:**
- **PNG** (raster) - pick a resolution scale; use **2x or 3x for publication quality**
  (higher scale = sharper but larger).
- **SVG** (editable vector) - resolution-independent (always sharp), best if they will
  keep editing or need a scalable figure for the paper.
- **PDF** (vector, for print).
Default to **PNG at 2x** when the user has no preference. Any of these show up in the
Manuscript tab's Figures list.

1. **Resolve the project root** (do NOT trust the working directory, especially under
   Codex). If the Qoka MCP is available, call `get_workspace_info` for the project path;
   otherwise walk up to the nearest ancestor containing a `.qoka` folder:
   ```bash
   root="$PWD"; while [ "$root" != "/" ] && [ ! -d "$root/.qoka" ]; do root="$(dirname "$root")"; done
   ```
   If `root` is `/` (no `.qoka`), you are not in a Qoka project - ask the user for the
   project folder instead of guessing.

2. **Export the figure and get its DATA from Penpot.** IMPORTANT: the remote Penpot MCP
   has local file-system access DISABLED, so it cannot write a file itself - you obtain
   the exported bytes and write them. Export in the chosen FORMAT and (for PNG) the chosen
   SCALE:
   - Call `export_shape` with the format/scale and read the base64 bytes from its result
     (verified: it returns `{ "type": "image", "data": "<base64>", "mimeType": "..." }`).
   - If needed, use `execute_code` to run the Penpot plugin export with `{ type, scale }`
     and return the result as a base64 string.

3. **Write the bytes to `<root>/.qoka/figures/`** with a short, slugified name and the
   chosen extension (`.png` / `.svg` / `.pdf`). From base64:
   ```bash
   mkdir -p "$root/.qoka/figures"
   printf '%s' "<BASE64>" | base64 -d > "$root/.qoka/figures/<short-figure-name>.<ext>"
   wc -c "$root/.qoka/figures/<short-figure-name>.<ext>"   # non-empty; for PNG, head -c 8 shows the PNG magic
   ```
   Then tell the user it is saved to the **Manuscript tab's Figures list** (phrase it that
   way to the user - do not mention the internal `.qoka/figures` path).

4. **If you could NOT get the image data** (the export tool returned no bytes - a remote
   mode limitation), do not pretend it was saved. Tell the user plainly that the export
   downloaded to their browser's Downloads folder and give them the exact target so they
   can move it in themselves: the project's `.qoka/figures/` folder (Manuscript ->
   Figures reads from there). Offer to retry via `execute_code` if that path is available.

- The ONLY save location for figures is `<root>/.qoka/figures/` (this is the internal
  path; to the user, call it the Manuscript tab's Figures list). Never save figures to
  `analysis/`, `results/`, `data/`, or the project root.
- For publication quality: PNG at 2x-3x scale, or SVG/PDF (vector, always sharp).

## Rules

- Figures are drawn ONLY through Penpot, never as an AI-generated raster image (raster
  images cannot go directly into a paper).
- Never invent a Penpot connection. If the `penpot` MCP tools are not present, follow
  step 3 (route the user to Settings) - do not pretend to draw.
- This skill is for schematic/illustrative figures. For data charts computed from a
  dataset, use normal plotting code instead.
