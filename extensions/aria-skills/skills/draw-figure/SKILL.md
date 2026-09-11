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
figure"), save it into the project so it appears in the **Manuscript tab's Figure
library**. Use the Qoka **`save_figure`** MCP tool for this - **NOT run_code and NOT
Bash** (run_code creates `results/<run>/` and `analysis/<run>/` folders, and a figure is
not analysis code, so it must never clutter those).

**First, unless the user already specified, ask which FORMAT and QUALITY they want:**
- **PNG** (raster) - pick a resolution scale; use **2x or 3x for publication quality**
  (higher scale = sharper but larger).
- **SVG** (editable vector) - resolution-independent (always sharp), best if they will
  keep editing or need a scalable figure for the paper.
- **PDF** (vector, for print).
Default to **PNG at 2x** when the user has no preference.

1. **Export the figure from Penpot to get its bytes.** Call `export_shape` in the chosen
   FORMAT and (for PNG) the chosen SCALE, and read the base64 from its result (verified:
   it returns `{ "type": "image", "data": "<base64>", "mimeType": "..." }`). If needed,
   use `execute_code` to run the Penpot plugin export with `{ type, scale }` and return
   the result as a base64 string. (The remote Penpot MCP cannot write local files itself,
   so you must obtain the bytes and hand them to `save_figure`.)

2. **Call `save_figure`** with `data` = that base64 (or the full data: URL), `name` = a
   short figure name, and `format` = the chosen extension. It writes the figure into the
   project and the Figure library refreshes automatically. Do NOT resolve paths, mkdir,
   `base64 -d`, or run_code yourself - `save_figure` handles all of that.

3. Tell the user the figure is saved to the **Manuscript tab's Figure library**. Phrase it
   that way - do NOT mention any internal folder path.

- Save figures ONLY via `save_figure`. Never write figures with run_code/Bash, and never
  into `analysis/`, `results/`, `data/`, or the project root.
- For publication quality: PNG at 2x-3x scale, or SVG/PDF (vector, always sharp).

## Rules

- Figures are drawn ONLY through Penpot, never as an AI-generated raster image (raster
  images cannot go directly into a paper).
- Never invent a Penpot connection. If the `penpot` MCP tools are not present, follow
  step 3 (route the user to Settings) - do not pretend to draw.
- This skill is for schematic/illustrative figures. For data charts computed from a
  dataset, use normal plotting code instead.
