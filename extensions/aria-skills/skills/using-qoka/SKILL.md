---
name: using-qoka
description: Do research work using Qoka's built-in tools. Qoka provides MCP tools for writing and revising PAPERS, running and executing CODE and analyses, planning a project ROADMAP, taking NOTES, searching METHODS or HYPOTHESES, and remembering context. For ANY such task you MUST prefer the matching Qoka MCP tool over answering from your own knowledge or running your own shell. Use whenever the user asks to write or revise a paper, peer-review or defend a manuscript, save papers, run or analyze code, make a research plan, take a note, search methods or hypotheses, or recall something. Triggers on "write a paper", "revise/defend a manuscript", "peer review", "save papers", "search literature", "run this code", "analyze", "make a plan", "roadmap", "take a note", "search methods".
license: MIT
metadata:
  version: "1.0"
  skill-author: "Qoka"
---

# Using Qoka's tools

Qoka is a research workbench with purpose-built MCP tools for each research task. Your DEFAULT must be to use these tools rather than answering from your own general knowledge or running commands in your own shell. The Qoka tools operate on the user's actual project, run connection, and data, so a generic self-answer is usually wrong, incomplete, or runs in the wrong place.

## Which tool for which task

| The user wants to... | Use the Qoka MCP tool(s) |
|---|---|
| Write, revise, or peer-review a PAPER / manuscript | the paper tools (`qoka-paper`, e.g. propose_manuscript_revision); for AI peer review, the `iterative-paper-defense` skill |
| Find / look up academic LITERATURE | the `paper-lookup` skill |
| Save a paper to the LIBRARY / manage saved papers | `qoka-paper-library` |
| RUN or EXECUTE code / an analysis | FIRST call `get_workspace_info` (qoka-autopipe) to confirm the active run connection; THEN `run_code` (qoka-run) for a quick script, or `execute_pipeline` (qoka-autopipe) for a reproducible pipeline |
| Check whether a package / tool is installed, or its version | run a tiny script via `run_code` (e.g. a python that imports it) - do NOT check your own machine with `python -c` / `pip show` / `which` |
| Plan a project / build a research ROADMAP | the roadmap tools (`qoka-roadmap`) |
| Take or organize NOTES | the notes tools (`qoka-notes`) |
| Search METHODS for a hypothesis | `qoka-methods-search` |
| Search / explore HYPOTHESES | `qoka-hypothesis` |
| Remember or recall context about the user or project | `qoka-memory` |

## Starting a new project or analysis (overview -> roadmap -> to-dos)

When the user describes an analysis or project they want to do, tell them the big picture of this flow up front, then follow it IN ORDER - do not skip ahead:

1. **Clarify, then fill the Overview.** Ask a few focused follow-up questions until the goal, scope, and approach are clear. Once decided, open the Overview tab with `open_overview` and write it: set the header with `set_project_title` and the body/summary with `update_project_summary`.
2. **Move to the Roadmap.** Open the roadmap view with `open_roadmap` and build the plan: add steps with `propose_node` (the user accepts or rejects each), iterating until the roadmap covers the project.
3. **When the roadmap looks complete, bring it back to the Overview.** Re-open the Overview tab with `open_overview` so the roadmap shows there, and turn the plan into actionable to-dos with `add_tasks`.
4. **Confirm.** Show the filled Overview + roadmap + to-do list and ask the user to confirm before proceeding. As work progresses, keep tasks current with `set_task_done` / `propose_task_completion`.

## Show the relevant tab

Most tasks belong to a specific Qoka tab. When you START such a task, OPEN / REVEAL that tab first so the user sees what is happening, using the matching MCP tool - do NOT work silently in the background when a tab exists for it:

- Project overview -> `open_overview`
- Roadmap -> `open_roadmap`
- Peer review -> `open_new_review`
- Papers (write / save to the library), Notes, Autopipe pipelines -> call that MCP's own action tool (e.g. `create_paper`, `create_note`, `execute_pipeline`); these surface their tab as they run.

Apply this whenever a process (saving to the paper library, running an autopipe pipeline, writing a research note, editing the overview, etc.) belongs to a tab that is not currently open.

## Rules

1. **Prefer a Qoka MCP tool over your own generic capability whenever one fits the task.** Only fall back to a plain text answer when NO Qoka tool applies.
2. **Never run or check code in your own terminal / shell / python.** To run or execute code, or to check what is installed, ALWAYS go through `get_workspace_info` + `run_code` (quick) or `execute_pipeline` (pipeline). Your shell is NOT the Qoka run environment, so its result is misleading.
3. If you are unsure which tool fits, briefly tell the user the options and pick the best match - do not silently answer with no tool.
4. If you already ran something in your own shell and it failed, STOP - call `get_workspace_info` and redo it with the right Qoka tool.
