/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, append, clearNode } from '../../../../../base/browser/dom.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { ariaHelpActionId } from '../../../aria/browser/ariaHelpEditor.js';
import { SettingsSection } from './settingsSection.js';

interface SkillRow {
	name: string;
	category: string;
	description: string;
	type: 'default' | 'user';
	group?: string;
	source?: string;
	envVars: { name: string; required: boolean }[];
	totalKeyCount?: number;
	missingKeyCount?: number;
	requiredCount?: number;
	requiredMissingCount?: number;
	optionalCount?: number;
	optionalMissingCount?: number;
}
interface EnvVarRow { name: string; value: string; required?: boolean }
interface SkillsState { defaults: SkillRow[]; users: SkillRow[]; categories: string[]; envVars: EnvVarRow[] }

/** Default-skill groups that render as their own nested collapsible subgroup under
 *  Default Skills (mirrors the retired Skills view). */
const DEFAULT_SKILL_GROUPS = ['K-Dense'];

/**
 * Skills section: a collapsible tree of skills (Default - with a nested K-Dense
 * subgroup - and My Skills), each expanding in place to its detail (description,
 * source, category, required/optional keys), plus a search box, a Qoka-styled
 * category filter, and the Environment Variables list. Reuses the Skills backend
 * (`aria.skills.getState` + `aria.skills.*` action commands).
 */
export class SkillsSection extends SettingsSection {

	constructor(body: HTMLElement, commandService: ICommandService, header?: HTMLElement) {
		super(body, commandService, header);
		this.addHeaderTextAction('How to use?', 'How to use Skills', () => {
			void this.commandService.executeCommand(ariaHelpActionId('skills'));
		});
	}

	private state: SkillsState | undefined;
	private search = '';
	private category = '';
	private readonly expanded = new Set<string>();
	private readonly collapsedGroups = new Set<string>();
	private categoryMenuClose: (() => void) | undefined;

	private listEl: HTMLElement | undefined;
	private envEl: HTMLElement | undefined;

	async refresh(): Promise<void> {
		try { this.state = await this.commandService.executeCommand<SkillsState>('aria.skills.getState'); } catch { /* booting */ }
		this.render();
	}

	private render(): void {
		this.categoryMenuClose?.();
		clearNode(this.body);
		const state = this.state;
		if (!state) {
			const p = append(this.body, $('div'));
			p.textContent = 'Loading skills...';
			Object.assign(p.style, { opacity: '0.6', fontSize: '12px' });
			return;
		}

		// Toolbar: search + category dropdown + Add. Built once; typing re-renders only
		// the list so the search box keeps focus.
		const toolbar = append(this.body, $('div'));
		Object.assign(toolbar.style, { display: 'flex', gap: '6px', marginBottom: '10px', alignItems: 'center' });
		const search = append(toolbar, $('input')) as HTMLInputElement;
		search.type = 'text';
		search.placeholder = 'Search skills...';
		search.value = this.search;
		Object.assign(search.style, {
			flex: '1', minWidth: '0', boxSizing: 'border-box', padding: '4px 6px', fontSize: '12px', borderRadius: '6px',
			border: '1px solid var(--vscode-dropdown-border, rgba(127,127,127,0.35))',
			background: 'var(--vscode-input-background)', color: 'var(--vscode-input-foreground)',
		});
		search.oninput = () => { this.search = search.value; this.renderList(); };
		this.renderCategoryDropdown(toolbar, state.categories);
		const add = append(toolbar, $('button')) as HTMLButtonElement;
		add.textContent = '+ Add';
		Object.assign(add.style, {
			flexShrink: '0', padding: '4px 12px', borderRadius: '4px', cursor: 'pointer', fontSize: '12px',
			border: '1px solid var(--vscode-button-border, transparent)',
			background: 'var(--vscode-button-background)', color: 'var(--vscode-button-foreground)',
		});
		add.onclick = () => { void this.commandService.executeCommand('aria.skills.addSkillStub'); };

		this.listEl = append(this.body, $('div'));
		this.renderList();

		this.envEl = append(this.body, $('div'));
		this.renderEnv();
	}

	// --- category dropdown (Qoka-styled) -----------------------------------

	private renderCategoryDropdown(toolbar: HTMLElement, categories: string[]): void {
		const trigger = append(toolbar, $('div'));
		trigger.title = 'Filter by category';
		Object.assign(trigger.style, {
			display: 'flex', alignItems: 'center', gap: '6px', maxWidth: '40%', flexShrink: '0', boxSizing: 'border-box',
			fontSize: '11px', padding: '4px 8px', borderRadius: '6px', cursor: 'pointer',
			background: 'var(--vscode-dropdown-background)', color: 'var(--vscode-dropdown-foreground)',
			border: '1px solid var(--vscode-dropdown-border, rgba(127,127,127,0.35))',
		});
		const label = append(trigger, $('span'));
		label.textContent = this.category || 'All categories';
		Object.assign(label.style, { flex: '1', minWidth: '0', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' });
		const chevron = append(trigger, $('span.codicon.codicon-chevron-down')) as HTMLElement;
		Object.assign(chevron.style, { fontSize: '12px', opacity: '0.8', flexShrink: '0' });
		trigger.onclick = () => {
			if (this.categoryMenuClose) { this.categoryMenuClose(); return; }
			this.openCategoryMenu(trigger, categories);
		};
	}

	private openCategoryMenu(trigger: HTMLElement, categories: string[]): void {
		const doc = trigger.ownerDocument;
		const rect = trigger.getBoundingClientRect();
		const menu = doc.createElement('div');
		Object.assign(menu.style, {
			position: 'fixed', left: `${rect.left}px`, top: `${rect.bottom + 4}px`, minWidth: `${Math.max(rect.width, 160)}px`, maxWidth: '260px',
			zIndex: '3000', background: 'var(--vscode-editorWidget-background, var(--vscode-dropdown-background))',
			border: '1px solid var(--vscode-editorWidget-border, rgba(127,127,127,0.35))', borderRadius: '8px',
			boxShadow: '0 6px 24px rgba(0,0,0,0.35)', padding: '4px', maxHeight: '260px', overflowY: 'auto',
			fontFamily: 'var(--vscode-font-family, system-ui, sans-serif)', fontSize: '12px', color: 'var(--vscode-foreground)',
		});
		const close = () => { doc.removeEventListener('mousedown', onDown, true); doc.removeEventListener('keydown', onKey, true); menu.remove(); this.categoryMenuClose = undefined; };
		const onDown = (e: MouseEvent) => { const t = e.target as Node; if (!menu.contains(t) && !trigger.contains(t)) { close(); } };
		const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { close(); } };
		const addItem = (value: string, text: string) => {
			const item = append(menu, $('div'));
			Object.assign(item.style, { display: 'flex', alignItems: 'center', gap: '8px', padding: '5px 8px', borderRadius: '5px', cursor: 'pointer' });
			item.addEventListener('mouseenter', () => { item.style.background = 'var(--vscode-list-hoverBackground, rgba(127,127,127,0.15))'; });
			item.addEventListener('mouseleave', () => { item.style.background = 'transparent'; });
			const check = append(item, $('span.codicon.codicon-check')) as HTMLElement;
			Object.assign(check.style, { fontSize: '13px', flexShrink: '0', opacity: '0.85', visibility: this.category === value ? 'visible' : 'hidden' });
			const l = append(item, $('span')); l.textContent = text; Object.assign(l.style, { flex: '1', minWidth: '0', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' });
			item.onclick = () => { close(); this.category = value; this.render(); };
		};
		addItem('', 'All categories');
		for (const c of categories) { addItem(c, c); }
		doc.body.appendChild(menu);
		doc.addEventListener('mousedown', onDown, true);
		doc.addEventListener('keydown', onKey, true);
		this.categoryMenuClose = close;
	}

	// --- skill tree --------------------------------------------------------

	private renderList(): void {
		const list = this.listEl;
		if (!list) { return; }
		clearNode(list);
		const state = this.state!;
		const defaults = this.filter(state.defaults);
		const ungrouped = defaults.filter(s => !s.group || !DEFAULT_SKILL_GROUPS.includes(s.group));
		const users = this.filter(state.users);

		const defaultGroup = this.renderGroup(list, 'default', 'Default Skills', defaults.length);
		if (defaultGroup) {
			for (const s of ungrouped) { this.renderSkill(defaultGroup, s); }
			for (const g of DEFAULT_SKILL_GROUPS) {
				const rows = defaults.filter(s => s.group === g);
				if (!rows.length) { continue; }
				const sub = this.renderGroup(defaultGroup, `group:${g}`, `${g} Skills`, rows.length, true);
				if (sub) { for (const s of rows) { this.renderSkill(sub, s); } }
			}
		}

		const usersGroup = this.renderGroup(list, 'users', 'My Skills', users.length);
		if (usersGroup) {
			if (users.length === 0) {
				const none = append(usersGroup, $('div'));
				none.textContent = 'No skills added yet. Click "+ Add" above.';
				Object.assign(none.style, { fontSize: '11px', opacity: '0.5', padding: '4px 0' });
			}
			for (const s of users) { this.renderSkill(usersGroup, s); }
		}
	}

	/** A collapsible group header; returns its body element, or undefined when collapsed. */
	private renderGroup(parent: HTMLElement, key: string, title: string, count: number, nested = false): HTMLElement | undefined {
		const collapsed = this.collapsedGroups.has(key);
		const header = append(parent, $('div'));
		Object.assign(header.style, { display: 'flex', alignItems: 'center', gap: '4px', cursor: 'pointer', margin: nested ? '8px 0 4px' : '12px 0 6px', paddingLeft: nested ? '10px' : '0' });
		const chevron = append(header, $(`span.codicon.${collapsed ? 'codicon-chevron-right' : 'codicon-chevron-down'}`)) as HTMLElement;
		Object.assign(chevron.style, { fontSize: '13px', opacity: '0.8' });
		const t = append(header, $('div'));
		t.textContent = `${title} (${count})`;
		Object.assign(t.style, { fontSize: nested ? '11px' : '11.5px', fontWeight: '600', opacity: '0.85' });
		header.onclick = () => { if (collapsed) { this.collapsedGroups.delete(key); } else { this.collapsedGroups.add(key); } this.renderList(); };
		if (collapsed) { return undefined; }
		const body = append(parent, $('div'));
		if (nested) { body.style.paddingLeft = '10px'; }
		return body;
	}

	private keyBadge(row: HTMLElement, s: SkillRow): void {
		const total = s.totalKeyCount ?? s.envVars.length;
		const reqMissing = s.requiredMissingCount ?? 0;
		const optMissing = s.optionalMissingCount ?? 0;
		const missing = s.missingKeyCount ?? (reqMissing + optMissing);
		const pill = (text: string, fg: string, bg: string) => {
			const p = append(row, $('span'));
			p.textContent = text;
			Object.assign(p.style, { flexShrink: '0', fontSize: '10px', padding: '1px 7px', borderRadius: '999px', background: bg, color: fg, marginLeft: '4px' });
		};
		if (total === 0) { pill('No key needed', 'var(--vscode-foreground)', 'rgba(127,127,127,0.18)'); return; }
		if (missing === 0) { pill('keys set', '#3fb950', 'rgba(46,160,67,0.18)'); return; }
		if (reqMissing > 0) { pill(`${reqMissing} required`, '#f85149', 'rgba(255,82,82,0.18)'); }
		if (optMissing > 0) { pill(`${optMissing} optional`, '#c0a000', 'rgba(255,214,0,0.20)'); }
		if (reqMissing === 0 && optMissing === 0) { pill(`${missing} missing`, '#f85149', 'rgba(255,82,82,0.18)'); }
	}

	private renderSkill(parent: HTMLElement, s: SkillRow): void {
		const isOpen = this.expanded.has(s.name);
		const card = append(parent, $('div'));
		Object.assign(card.style, { border: '1px solid var(--vscode-widget-border, rgba(127,127,127,0.22))', borderRadius: '6px', padding: '7px 10px', marginBottom: '6px' });

		const head = append(card, $('div'));
		Object.assign(head.style, { display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' });
		const chevron = append(head, $(`span.codicon.${isOpen ? 'codicon-chevron-down' : 'codicon-chevron-right'}`)) as HTMLElement;
		Object.assign(chevron.style, { fontSize: '13px', opacity: '0.7', flexShrink: '0' });
		const name = append(head, $('span'));
		name.textContent = s.name;
		Object.assign(name.style, { flex: '1', minWidth: '0', fontSize: '12px', fontWeight: '600', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' });
		this.keyBadge(head, s);
		head.onclick = () => { if (isOpen) { this.expanded.delete(s.name); } else { this.expanded.add(s.name); } this.renderList(); };

		if (isOpen) { this.renderSkillDetail(card, s); }
	}

	private renderSkillDetail(card: HTMLElement, s: SkillRow): void {
		const detail = append(card, $('div'));
		Object.assign(detail.style, { marginTop: '8px', paddingTop: '8px', borderTop: '1px solid rgba(127,127,127,0.18)', display: 'flex', flexDirection: 'column', gap: '6px', fontSize: '11.5px' });

		if (s.description) {
			const d = append(detail, $('div')); d.textContent = s.description; Object.assign(d.style, { opacity: '0.85', lineHeight: '1.5' });
		}
		// Source link only for user-added skills; default skills are bundled, so their
		// path is noise.
		if (s.source && s.type === 'user') {
			const src = append(detail, $('div'));
			const a = append(src, $('a')) as HTMLAnchorElement;
			a.textContent = s.source; a.href = s.source;
			Object.assign(a.style, { color: 'var(--vscode-textLink-foreground)', textDecoration: 'none', fontSize: '11px', wordBreak: 'break-all' });
		}

		// Category (editable).
		const catRow = append(detail, $('div'));
		Object.assign(catRow.style, { display: 'flex', alignItems: 'center', gap: '6px' });
		const catLabel = append(catRow, $('span')); catLabel.textContent = 'Category:'; catLabel.style.opacity = '0.6';
		const catVal = append(catRow, $('span')); catVal.textContent = s.category || '(none)'; catVal.style.opacity = s.category ? '1' : '0.5';
		const catEdit = append(catRow, $('span.codicon.codicon-edit')) as HTMLElement;
		catEdit.title = 'Edit category';
		Object.assign(catEdit.style, { cursor: 'pointer', opacity: '0.6', padding: '2px' });
		catEdit.onclick = (e) => { e.stopPropagation(); void this.commandService.executeCommand('aria.skills.editCategory', s.name); };

		// Keys in two columns split by a center divider: Required on the left, Optional
		// on the right. Each key has its own edit (pencil) button - there is no separate
		// "Configure keys" button any more.
		const total = s.totalKeyCount ?? s.envVars.length;
		if (total > 0) {
			const valueByName = new Map((this.state?.envVars ?? []).map(v => [v.name, v.value]));
			const cols = append(detail, $('div'));
			Object.assign(cols.style, { display: 'flex', marginTop: '2px' });
			this.keyColumn(cols, 'Required', s.envVars.filter(v => v.required), valueByName, true);
			this.keyColumn(cols, 'Optional', s.envVars.filter(v => !v.required), valueByName, false);
		}

		// Actions: only Uninstall (user skills). Keys are edited per-key above.
		if (s.type === 'user') {
			const actions = append(detail, $('div'));
			Object.assign(actions.style, { display: 'flex', gap: '8px', marginTop: '4px' });
			const del = append(actions, $('button')) as HTMLButtonElement;
			del.textContent = 'Uninstall';
			this.secondaryButton(del);
			del.onclick = async (e) => { e.stopPropagation(); try { await this.commandService.executeCommand('aria.skills.uninstallSkill', s.name); } catch { /* handled */ } await this.refresh(); };
		}
	}

	/** One key column (Required / Optional). Each key row shows a set/missing dot, the
	 *  name, and a pencil that edits that key's value via aria.skills.editEnvVar. */
	private keyColumn(parent: HTMLElement, title: string, vars: { name: string }[], valueByName: Map<string, string>, dividerRight: boolean): void {
		const col = append(parent, $('div'));
		Object.assign(col.style, { flex: '1', minWidth: '0', padding: '0 10px', boxSizing: 'border-box' });
		if (dividerRight) { col.style.borderRight = '1px solid rgba(127,127,127,0.2)'; col.style.paddingLeft = '0'; }
		else { col.style.paddingRight = '0'; }
		const gl = append(col, $('div')); gl.textContent = title; Object.assign(gl.style, { fontSize: '11px', fontWeight: '600', opacity: '0.75', marginBottom: '3px' });
		if (!vars.length) {
			const none = append(col, $('div')); none.textContent = '(none)'; Object.assign(none.style, { fontSize: '10.5px', opacity: '0.4' });
			return;
		}
		for (const v of vars) {
			const set = !!valueByName.get(v.name);
			const row = append(col, $('div'));
			Object.assign(row.style, { display: 'flex', alignItems: 'center', gap: '6px', margin: '2px 0' });
			const dot = append(row, $('span'));
			Object.assign(dot.style, { width: '7px', height: '7px', borderRadius: '50%', flexShrink: '0', background: set ? 'var(--vscode-charts-green, #4caf50)' : 'var(--vscode-charts-red, #f14c4c)' });
			const n = append(row, $('span')); n.textContent = v.name; Object.assign(n.style, { flex: '1', minWidth: '0', fontFamily: 'var(--vscode-editor-font-family, monospace)', fontSize: '11px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' });
			const edit = append(row, $('span.codicon.codicon-edit')) as HTMLElement;
			edit.title = 'Edit this key';
			Object.assign(edit.style, { cursor: 'pointer', opacity: '0.6', flexShrink: '0', padding: '2px' });
			edit.onclick = (e) => { e.stopPropagation(); void this.commandService.executeCommand('aria.skills.editEnvVar', v.name); };
		}
	}

	// --- environment variables --------------------------------------------

	private renderEnv(): void {
		const env = this.envEl;
		if (!env) { return; }
		clearNode(env);
		const envVars = this.state?.envVars ?? [];
		const header = append(env, $('div'));
		Object.assign(header.style, { display: 'flex', alignItems: 'center', gap: '8px', margin: '16px 0 6px' });
		const title = append(header, $('div'));
		title.textContent = `Environment Variables (${envVars.length})`;
		Object.assign(title.style, { flex: '1', fontSize: '11.5px', fontWeight: '600', opacity: '0.85' });
		const open = append(header, $('button')) as HTMLButtonElement;
		open.textContent = 'Open ~/.env';
		this.secondaryButton(open);
		open.onclick = () => { void this.commandService.executeCommand('aria.skills.openEnvFile'); };

		if (envVars.length === 0) {
			const none = append(env, $('div'));
			none.textContent = 'No environment variables yet.';
			Object.assign(none.style, { fontSize: '11px', opacity: '0.5', padding: '2px 0' });
			return;
		}
		const required = envVars.filter(v => v.required);
		const optional = envVars.filter(v => !v.required);
		this.renderEnvGroup(env, 'Required', required);
		this.renderEnvGroup(env, 'Optional', optional);
	}

	private renderEnvGroup(parent: HTMLElement, label: string, vars: EnvVarRow[]): void {
		if (!vars.length) { return; }
		const gl = append(parent, $('div')); gl.textContent = label; Object.assign(gl.style, { fontSize: '11px', fontWeight: '600', opacity: '0.7', margin: '6px 0 2px' });
		for (const v of vars) {
			const row = append(parent, $('div'));
			Object.assign(row.style, { display: 'flex', alignItems: 'center', gap: '8px', padding: '4px 0' });
			const dot = append(row, $('span'));
			Object.assign(dot.style, { width: '7px', height: '7px', borderRadius: '50%', flexShrink: '0', background: v.value ? 'var(--vscode-charts-green, #4caf50)' : 'var(--vscode-charts-yellow, #e6c200)' });
			const name = append(row, $('span')); name.textContent = v.name; Object.assign(name.style, { flex: '1', minWidth: '0', fontSize: '12px', fontFamily: 'var(--vscode-editor-font-family, monospace)' });
			const state = append(row, $('span')); state.textContent = v.value ? 'set' : 'not set'; Object.assign(state.style, { fontSize: '10px', opacity: '0.6', flexShrink: '0' });
			const edit = append(row, $('span.codicon.codicon-edit')) as HTMLElement;
			edit.title = 'Edit value';
			Object.assign(edit.style, { cursor: 'pointer', opacity: '0.6', flexShrink: '0', padding: '2px' });
			edit.onclick = () => { void this.commandService.executeCommand('aria.skills.editEnvVar', v.name); };
		}
	}

	private filter(skills: SkillRow[]): SkillRow[] {
		const q = this.search.trim().toLowerCase();
		return skills.filter(s =>
			(!this.category || s.category === this.category) &&
			(!q || s.name.toLowerCase().includes(q) || (s.description ?? '').toLowerCase().includes(q) || (s.category ?? '').toLowerCase().includes(q)));
	}

	private secondaryButton(btn: HTMLButtonElement): void {
		Object.assign(btn.style, {
			padding: '3px 10px', borderRadius: '4px', cursor: 'pointer', fontSize: '11px',
			border: '1px solid var(--vscode-button-border, transparent)',
			background: 'var(--vscode-button-secondaryBackground, rgba(127,127,127,0.2))',
			color: 'var(--vscode-button-secondaryForeground, var(--vscode-foreground))',
		});
	}

	override dispose(): void {
		this.categoryMenuClose?.();
		super.dispose();
	}
}
