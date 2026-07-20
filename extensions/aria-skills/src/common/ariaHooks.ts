/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Qoka's Claude Code hook integration.
 *
 * Claude Code reads ~/.claude/settings.json on session start and runs the
 * registered PreToolUse hooks before each tool invocation. We use that to
 * inject Qoka's environment rules whenever Claude is about to execute a
 * shell command that touches env vars, .env files, or Python package
 * installation - the operations where skill SKILL.md instructions tend
 * to conflict with Qoka's UI-based workflow.
 *
 * Why not match on a "Skill" tool name? Claude Code's matcher field
 * filters on tool names (Bash / Edit / Write / etc.) - skills are a
 * prompt-level pattern, not a tool, and don't trigger their own event.
 * The verified behaviour from our manual hook test was that even when
 * the user says "use pyzotero", Claude runs `cat .env` / `ls -la | grep
 * zotero` / etc. inside the user's cwd, not inside ~/.claude/skills/.
 * So path-based detection misses every real skill operation.
 *
 * Instead, the hook script matches the command content. If the Bash
 * command references .env files, calls pip / conda for install, or
 * touches credential-shaped env vars, we inject Qoka's guidance via
 * the verified JSON envelope:
 *
 *   {"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":"..."}}
 *
 * Plain stdout is silently dropped by Claude Code - only this JSON
 * shape lands in Claude's context.
 */

const HOOK_DIR = path.join(os.homedir(), '.config/aria/hooks');
const HOOK_SCRIPT_PATH = path.join(HOOK_DIR, 'pre-tool-use.sh');
const SETTINGS_PATH = path.join(os.homedir(), '.claude/settings.json');

/**
 * Stable identifier embedded in the hook command string. We grep for it
 * when reconciling ~/.claude/settings.json so repeated activations don't
 * duplicate the entry, and so the user can recognise which line Qoka
 * owns if they open the file.
 */
const ARIA_HOOK_COMMAND = `"$HOME/.config/aria/hooks/pre-tool-use.sh"`;

/**
 * Codex reads PreToolUse hooks and shares Claude's hookSpecificOutput
 * envelope (so the default script needs no format arg). Written to a
 * separate ~/.codex/hooks.json so we never risk corrupting config.toml.
 * NOTE: the exact hooks-file location + shell-tool matcher are inferred
 * from docs - verify a blocked `cat .env` under Codex before relying on it.
 */
const CODEX_HOOKS_PATH = path.join(os.homedir(), '.codex', 'hooks.json');
const CODEX_EXTENSION_ID = 'openai.chatgpt';

/**
 * The actual hook script. Kept inline so a single source-of-truth lives
 * in the extension - every Qoka launch overwrites the on-disk copy with
 * the current text, so updating the guidance is just editing this
 * constant.
 *
 * Note on the JSON output: we use jq when available (much safer escaping
 * for the multi-line guidance string) and fall back to printf'ing a
 * single-line JSON when jq is missing. The guidance text in the printf
 * branch is intentionally simpler.
 */
const HOOK_SCRIPT_CONTENT = `#!/bin/bash
# Qoka PreToolUse hook - managed by the aria-skills extension.
# Regenerated on every Qoka launch; manual edits here will be overwritten.
#
# Injects Qoka's environment rules when Claude is about to run a shell
# command that touches env vars, .env files, or Python installs.
# Silent on unrelated Bash calls so we don't bloat Claude's context.

set -u

INPUT="$(cat)"

# Pull the command we're about to run. jq is preferred for correctness;
# the grep fallback handles machines without jq installed.
if command -v jq >/dev/null 2>&1; then
    COMMAND="$(printf '%s' "$INPUT" | jq -r '.tool_input.command // ""')"
else
    COMMAND="$(printf '%s' "$INPUT" \\
        | grep -oE '"command"[[:space:]]*:[[:space:]]*"[^"]*"' \\
        | head -1 \\
        | sed 's/.*"command"[[:space:]]*:[[:space:]]*"\\(.*\\)"$/\\1/')"
fi

# Empty command (rare - Claude Code occasionally emits empty payloads
# during init): nothing useful to evaluate, stay silent.
if [ -z "\${COMMAND}" ]; then
    exit 0
fi

# Step 1: hard-deny commands that would leak credential values to the
# transcript. PreToolUse permissionDecision="deny" stops the tool BEFORE
# it runs, so the value never lands in stdout (additionalContext-style
# guidance fires too late - Claude has already chosen the command and
# the tool output is captured even if Claude refuses to repeat it).
#
# We block, in order:
#   - File readers (cat / less / more / head / tail / view / bat) that
#     have a .env path in their args.
#   - grep / awk / sed against .env (these print matched lines, which
#     include values). grep -o / grep -l / grep -c stay allowed because
#     they don't surface the value.
#   - echo \$X_KEY, printenv X_TOKEN, and similar - direct variable
#     dereference of credential-shaped names.
#   - env | grep ... without a redacting sed pipe.
DENY=0
DENY_REASON=""

if printf '%s' "\${COMMAND}" | grep -qE '(^|[^a-zA-Z0-9_/])(cat|less|more|head|tail|view|bat)([[:space:]]+-[^[:space:]]+)*[[:space:]]+[^|;&]*\\.env([^a-zA-Z0-9_]|$)'; then
    DENY=1
    DENY_REASON="Reading the contents of an .env file (cat/less/head/tail/etc.) would surface credential values into the transcript."
fi
if [ "\${DENY}" -eq 0 ] && printf '%s' "\${COMMAND}" | grep -qE '(^|[^a-zA-Z0-9_])grep([[:space:]]+-[^oloc[:space:]][^[:space:]]*)*[[:space:]]+[^|;&]*\\.env([^a-zA-Z0-9_]|$)'; then
    # Allow only grep -o, grep -l, grep -c - they don't print matched lines.
    if ! printf '%s' "\${COMMAND}" | grep -qE 'grep[[:space:]]+-[^[:space:]]*[olc]'; then
        DENY=1
        DENY_REASON="grep against an .env file prints the matched line including the value. Use 'cut -d= -f1 ~/.env' for names only, or 'grep -c PATTERN ~/.env' for a hit count."
    fi
fi
if [ "\${DENY}" -eq 0 ] && printf '%s' "\${COMMAND}" | grep -qE '(^|[^a-zA-Z0-9_])(awk|sed)[[:space:]][^|;&]*\\.env([^a-zA-Z0-9_]|$)'; then
    DENY=1
    DENY_REASON="awk/sed against an .env file typically writes the matched value to stdout. Use a structured Python read inside a subprocess that doesn't print values."
fi
if [ "\${DENY}" -eq 0 ] && printf '%s' "\${COMMAND}" | grep -qE '(^|[^a-zA-Z0-9_])(echo|printf)[[:space:]]+["\\047]?\\\$\\{?[A-Z][A-Z0-9_]*_(KEY|TOKEN|SECRET|PASSWORD)'; then
    DENY=1
    DENY_REASON="echo / printf of a credential-named env var prints the value. Use [ -n \\"\\\$VAR\\" ] && echo \\"set (length \\\${#VAR})\\"."
fi
if [ "\${DENY}" -eq 0 ] && printf '%s' "\${COMMAND}" | grep -qE 'printenv[[:space:]]+[A-Z][A-Z0-9_]*_(KEY|TOKEN|SECRET|PASSWORD)'; then
    DENY=1
    DENY_REASON="printenv of a credential-named env var prints the value. Use the length-check pattern instead."
fi
if [ "\${DENY}" -eq 0 ] && printf '%s' "\${COMMAND}" | grep -qE 'env[[:space:]]*\\|[[:space:]]*grep' && ! printf '%s' "\${COMMAND}" | grep -qE 'sed[[:space:]]+["\\047]?[^"\\047]*=\\.\\*'; then
    # Allow env | grep VAR | sed 's/=.*/=<set>/' but block raw env | grep VAR.
    if printf '%s' "\${COMMAND}" | grep -qE 'env[[:space:]]*\\|[[:space:]]*grep[[:space:]]+[^|;&]*_(KEY|TOKEN|SECRET|PASSWORD|API)'; then
        DENY=1
        DENY_REASON="env | grep on a credential-named variable surfaces the value unless piped through a masking sed. Append | sed 's/=.*/=<set>/' to mask."
    fi
fi

if [ "\${DENY}" -eq 1 ]; then
    GUIDED_REDIRECT="Direct the user to Qoka's Skills tab (puzzle icon on the left sidebar). The skill card's [Enter keys] button (or the Environment Variables section's [Edit] button per row) is the only safe way to view or change a credential value - the input box shows the masked field with an Edit affordance, never echoing the value into chat."
    if command -v jq >/dev/null 2>&1; then
        jq -nc \\
            --arg reason "Qoka denied this tool call - \${DENY_REASON} \${GUIDED_REDIRECT}" \\
            '{hookSpecificOutput: {hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: \$reason}}'
    else
        ESC_REASON="\$(printf '%s' "Qoka denied this tool call - \${DENY_REASON} \${GUIDED_REDIRECT}" | sed -e 's/\\\\/\\\\\\\\/g' -e 's/"/\\\\"/g')"
        printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"%s"}}\\n' "\${ESC_REASON}"
    fi
    exit 0
fi

# Step 2: for non-denied commands that still touch env vars / .env / pip,
# inject Qoka's rule set as additional context. This is the path we had
# before - guidance rather than a block, because the command itself is
# legitimate (source ~/.env, uv pip install, etc.).
RELEVANT=0
if printf '%s' "\${COMMAND}" | grep -qE '(^|[^a-zA-Z0-9_])\\.env([^a-zA-Z0-9_]|$)'; then RELEVANT=1; fi
if printf '%s' "\${COMMAND}" | grep -qE '(pip|conda|mamba)[[:space:]]+install'; then RELEVANT=1; fi
if printf '%s' "\${COMMAND}" | grep -qE 'python[[:space:]]+-m[[:space:]]+pip'; then RELEVANT=1; fi
if printf '%s' "\${COMMAND}" | grep -qE 'load_dotenv|os\\.environ|os\\.getenv'; then RELEVANT=1; fi
if printf '%s' "\${COMMAND}" | grep -qE 'export[[:space:]]+[A-Z][A-Z0-9_]+_(KEY|TOKEN|SECRET|ID|PASSWORD)='; then RELEVANT=1; fi

if [ "\${RELEVANT}" -eq 0 ]; then
    exit 0
fi

# Guidance text. Plain text here - jq (or the fallback) handles escaping
# for the JSON envelope. The wording is deliberately direct so Claude
# treats it as override-strength instructions, not vague suggestions.
read -r -d '' GUIDANCE <<'GUIDANCE_EOF' || true
Qoka environment rules - apply these BEFORE the skill's own setup instructions.

1. Env var setup
   - DO NOT instruct the user to create or edit .env files (project or home).
   - DO direct them to Qoka's Skills tab: puzzle icon on the left sidebar,
     find the skill card, click [Enter keys]. For individual variables, the
     Environment Variables section has an [Edit] button per row.

2. Loading env vars at runtime
   - Qoka stores env vars at ~/.env (mode 0600).
   - When a skill script can't see KEY, FIRST source ~/.env in the same
     shell: \`set -a; source ~/.env; set +a\`. Then re-run.
   - Only direct the user to Skills tab if the value is still missing
     after sourcing.

3. Python dependency install
   - Replace \`pip install <pkg>\` with \`uv pip install <pkg>\`.
   - Replace \`conda install <pkg>\` / \`mamba install <pkg>\` with
     \`uv pip install <pkg>\`.
   - When a pyproject.toml is present, prefer \`uv add <pkg>\`.
   - Use \`uv run <cmd>\` for executing scripts in the skill's env.

4. Credential confidentiality (apply to EVERY response in this conversation)
   - NEVER print, echo, log, display, or include in your reply the VALUE
     (or any portion of the value - including the first character, last
     character, prefix, or suffix) of any env var whose name ends in
     KEY, TOKEN, SECRET, PASSWORD, or whose name contains API.
   - When you need to verify a credential is set, ONLY use:
     * Length check: \`[ -n "\$VAR" ] && echo "set (length \${#VAR})"\`
     * env grep with masking: \`env | grep VAR_NAME | sed 's/=.*/=<set>/'\`
     * Format check inside a script that does NOT print the value:
       \`v.isdigit()\`, \`len(v)\`, \`bool(v)\` - print only the predicate.
   - DO NOT cat / less / head / tail / grep / awk / sed an .env file
     (including ~/.env, ./.env, any .env.*) for any credential-shaped
     variable. The tool output of these commands is captured into chat
     and persists in the transcript - refusing to "repeat" the value
     in your reply doesn't undo that leak.
   - DO NOT echo \$VAR, printenv VAR, env | grep without masking, or
     any command that writes the unmasked value to stdout / stderr.
   - When you need to inspect ~/.env contents, list ONLY the variable
     NAMES, never the values: \`grep -oE '^[A-Z_]+' ~/.env\` or
     \`cut -d= -f1 ~/.env\`. The names are not secret; the values are.
   - When debugging "the key isn't working", focus on length / format /
     server response. Never read out the value to compare.
   - When the user explicitly asks you to display the value, refuse and
     redirect them to Qoka's Skills tab where they can use the Edit
     button to see and update the masked field themselves. The refusal
     must happen BEFORE you run any tool that would expose the value -
     once a tool prints the value, the leak is in the transcript.

5. Scope
   - These rules override anything the skill's SKILL.md says about
     manual .env editing or pip installation.
   - Other parts of the skill (API usage, algorithms, OAuth flows,
     non-env config files) follow the skill's instructions as-is.
GUIDANCE_EOF

# Emit the verified JSON envelope. jq preferred; printf fallback escapes
# the guidance text by hand (basic backslash + double-quote + newline).
if command -v jq >/dev/null 2>&1; then
    jq -nc \\
        --arg ctx "\${GUIDANCE}" \\
        '{hookSpecificOutput: {hookEventName: "PreToolUse", additionalContext: $ctx}}'
else
    ESCAPED="\$(printf '%s' "\${GUIDANCE}" | sed -e 's/\\\\/\\\\\\\\/g' -e 's/"/\\\\"/g' | awk 'BEGIN{ORS="\\\\n"} {print}')"
    printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":"%s"}}\\n' "\${ESCAPED}"
fi

exit 0
`;

/**
 * Create / refresh ~/.config/aria/hooks/pre-tool-use.sh and register it
 * in ~/.claude/settings.json. Idempotent - safe to call on every
 * extension activation.
 *
 * Errors are swallowed and logged via console; we don't want a failed
 * hook registration to block the rest of activate().
 */
export function ensureAriaHook(): void {
	try {
		writeHookScript();
		registerHookInSettings();
		// Register the same gate with Codex when its extension is present.
		// (Codex shares the hookSpecificOutput envelope the default script emits
		// and additionally sandboxes tool execution itself.)
		if (vscode.extensions.getExtension(CODEX_EXTENSION_ID)) {
			registerHookInCodex();
		}
	} catch (err) {
		console.error('[aria-skills] ensureAriaHook failed:', (err as Error).message);
	}
}

function writeHookScript(): void {
	fs.mkdirSync(HOOK_DIR, { recursive: true });
	// Always overwrite - the on-disk script must match the constant above
	// so guidance updates ship with the extension.
	fs.writeFileSync(HOOK_SCRIPT_PATH, HOOK_SCRIPT_CONTENT, { mode: 0o755 });
}

interface HookEntry {
	type?: string;
	command?: string;
	/** Codex shows this while the hook runs - used as a "hooks are loading" probe. */
	statusMessage?: string;
}

interface MatcherGroup {
	matcher?: string;
	hooks?: HookEntry[];
}

interface ClaudeSettings {
	hooks?: {
		PreToolUse?: MatcherGroup[];
		[key: string]: MatcherGroup[] | undefined;
	};
	[key: string]: unknown;
}

function registerHookInSettings(): void {
	fs.mkdirSync(path.dirname(SETTINGS_PATH), { recursive: true });

	let settings: ClaudeSettings = {};
	if (fs.existsSync(SETTINGS_PATH)) {
		try {
			const raw = fs.readFileSync(SETTINGS_PATH, 'utf8');
			settings = raw.trim() ? JSON.parse(raw) as ClaudeSettings : {};
		} catch (err) {
			// Don't clobber a settings.json we can't parse - back it up
			// so the user can recover, then start fresh. Better than
			// throwing and never registering the hook.
			const backup = `${SETTINGS_PATH}.bak.${Date.now()}`;
			fs.copyFileSync(SETTINGS_PATH, backup);
			console.warn(`[aria-skills] ~/.claude/settings.json was unparseable (${(err as Error).message}); backed up to ${backup}`);
			settings = {};
		}
	}

	settings.hooks ??= {};
	settings.hooks.PreToolUse ??= [];
	const preToolUse = settings.hooks.PreToolUse;

	// Is our hook already in the array? Identify by the command string
	// containing our well-known path. We tolerate the matcher being
	// "Bash" or a regex that includes Bash so the user can broaden the
	// scope themselves without us undoing it.
	const ariaEntry = preToolUse.find(group =>
		Array.isArray(group.hooks) &&
		group.hooks.some(h => typeof h.command === 'string' && h.command.includes(ARIA_HOOK_COMMAND.replace(/"/g, '')))
	);

	if (ariaEntry) {
		// Already present - make sure the matcher and command are still
		// in their expected shape, but otherwise leave the user's
		// customisations alone.
		ariaEntry.matcher ??= 'Bash';
		return;
	}

	preToolUse.push({
		matcher: 'Bash',
		hooks: [{ type: 'command', command: ARIA_HOOK_COMMAND }],
	});

	const tmpPath = `${SETTINGS_PATH}.tmp`;
	fs.writeFileSync(tmpPath, JSON.stringify(settings, null, 2));
	fs.renameSync(tmpPath, SETTINGS_PATH);
}

/**
 * Register the credential-safety gate with Codex via ~/.codex/hooks.json.
 * Codex shares Claude's hookSpecificOutput/permissionDecision envelope, so
 * the default script (no format arg) works. Idempotent; a separate file so
 * we never touch config.toml. Codex also sandboxes tool exec independently.
 */
function registerHookInCodex(): void {
	fs.mkdirSync(path.dirname(CODEX_HOOKS_PATH), { recursive: true });

	let settings: ClaudeSettings = {};
	if (fs.existsSync(CODEX_HOOKS_PATH)) {
		try {
			const raw = fs.readFileSync(CODEX_HOOKS_PATH, 'utf8');
			settings = raw.trim() ? JSON.parse(raw) as ClaudeSettings : {};
		} catch (err) {
			const backup = `${CODEX_HOOKS_PATH}.bak.${Date.now()}`;
			fs.copyFileSync(CODEX_HOOKS_PATH, backup);
			console.warn(`[aria-skills] ~/.codex/hooks.json was unparseable (${(err as Error).message}); backed up to ${backup}`);
			settings = {};
		}
	}

	settings.hooks ??= {};
	settings.hooks.PreToolUse ??= [];
	const preToolUse = settings.hooks.PreToolUse;

	const already = preToolUse.find(group =>
		Array.isArray(group.hooks) &&
		group.hooks.some(h => typeof h.command === 'string' && h.command.includes('pre-tool-use.sh'))
	);
	if (already) {
		// Codex's shell tool is named "Bash" (same canonical name as Claude),
		// and the command reads .tool_input.command identically. Self-heal any
		// older entry that used the wrong matcher.
		if (already.matcher === 'Bash') {
			return;
		}
		already.matcher = 'Bash';
	} else {
		preToolUse.push({
			matcher: 'Bash',
			hooks: [{ type: 'command', command: ARIA_HOOK_COMMAND, statusMessage: 'Qoka: checking command for credential safety' }],
		});
	}

	const tmpPath = `${CODEX_HOOKS_PATH}.tmp`;
	fs.writeFileSync(tmpPath, JSON.stringify(settings, null, 2));
	fs.renameSync(tmpPath, CODEX_HOOKS_PATH);
}
