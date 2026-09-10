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
   file the user currently has OPEN and connected in Penpot; if the tools report no
   connected file, ask the user to open a Penpot file and connect it (File -> MCP Server
   -> Connect). After drawing, tell the user how to refine it on the Penpot canvas:
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

1. **Resolve the project root** (do NOT trust the working directory, especially under
   Codex). If the Qoka MCP is available, call `get_workspace_info` for the project path;
   otherwise walk up to the nearest ancestor containing a `.qoka` folder:
   ```bash
   root="$PWD"; while [ "$root" != "/" ] && [ ! -d "$root/.qoka" ]; do root="$(dirname "$root")"; done
   ```
   If `root` is `/` (no `.qoka`), you are not in a Qoka project - ask the user for the
   project folder instead of guessing.

2. **Get the image DATA from Penpot.** IMPORTANT: the remote Penpot MCP has local
   file-system access DISABLED, so `export_shape` cannot write to a local path itself.
   You must obtain the exported image as DATA and write it yourself:
   - Call `export_shape` (PNG) and look for image bytes / base64 in its result.
   - If needed, use `execute_code` to export the shape/board in the Penpot plugin and
     return the result as a base64 string.

3. **Write the bytes to `<root>/.qoka/figures/`** with a short, slugified name. If you
   have base64 data:
   ```bash
   mkdir -p "$root/.qoka/figures"
   printf '%s' "<BASE64>" | base64 -d > "$root/.qoka/figures/<short-figure-name>.png"
   head -c 8 "$root/.qoka/figures/<short-figure-name>.png"   # sanity: PNG starts with the PNG magic
   ```
   Then tell the user it is saved and now appears in **Manuscript -> Figures** (and under
   the Analysis tab's `.qoka/figures/`).

4. **If you could NOT get the image data** (the export tool returned no bytes - a remote
   mode limitation), do not pretend it was saved. Tell the user plainly that the export
   downloaded to their browser's Downloads folder and give them the exact target so they
   can move it in themselves: the project's `.qoka/figures/` folder (Manuscript ->
   Figures reads from there). Offer to retry via `execute_code` if that path is available.

- The ONLY save location for figures is `<root>/.qoka/figures/`. Never save figures to
  `analysis/`, `results/`, `data/`, or the project root.
- Prefer PNG for the Figures thumbnails, but the user can also keep the editable Penpot
  file / an SVG export to keep refining.

## Rules

- Figures are drawn ONLY through Penpot, never as an AI-generated raster image (raster
  images cannot go directly into a paper).
- Never invent a Penpot connection. If the `penpot` MCP tools are not present, follow
  step 3 (route the user to Settings) - do not pretend to draw.
- This skill is for schematic/illustrative figures. For data charts computed from a
  dataset, use normal plotting code instead.
