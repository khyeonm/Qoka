/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { append, $, clearNode } from '../../../../base/browser/dom.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IViewPaneOptions, ViewPane } from '../../../browser/parts/views/viewPane.js';
import { IViewDescriptorService } from '../../../common/views.js';
import { CommandsRegistry, ICommandService } from '../../../../platform/commands/common/commands.js';

/**
 * Inject a one-time stylesheet that gives any element marked with the
 * `aria-themed-scrollable` class the workbench-style scrollbar
 * (slim, theme-tracked, no track) instead of the default Chromium
 * appearance. Idempotent — the second call (e.g. when the Paper Library
 * view also imports this file) is a no-op. We use `var(--vscode-...)`
 * so light/dark theme switches keep the slider in sync without us
 * having to listen for theme changes.
 */
export function ensureAriaPaneScrollbarStyle(): void {
	if (document.getElementById('aria-themed-scrollbar-style')) {
		return;
	}
	const style = document.createElement('style');
	style.id = 'aria-themed-scrollbar-style';
	style.textContent = `
		.aria-themed-scrollable::-webkit-scrollbar {
			width: 10px;
			height: 10px;
		}
		.aria-themed-scrollable::-webkit-scrollbar-track {
			background: transparent;
		}
		.aria-themed-scrollable::-webkit-scrollbar-thumb {
			background: var(--vscode-scrollbarSlider-background, rgba(121, 121, 121, 0.4));
			border-radius: 0;
		}
		.aria-themed-scrollable::-webkit-scrollbar-thumb:hover {
			background: var(--vscode-scrollbarSlider-hoverBackground, rgba(100, 100, 100, 0.7));
		}
		.aria-themed-scrollable::-webkit-scrollbar-thumb:active {
			background: var(--vscode-scrollbarSlider-activeBackground, rgba(191, 191, 191, 0.4));
		}
		.aria-themed-scrollable::-webkit-scrollbar-corner {
			background: transparent;
		}
	`;
	document.head.appendChild(style);
}

interface SkillRow {
	name: string;
	category: string;
	description: string;
	type: 'default' | 'user';
	envVars: { name: string; required: boolean }[];
	autoApprove: boolean;
	/** Set by the extension. How many declared env vars are still unset
	 *  in ~/.env — drives the "Configure keys" affordance on the card. */
	missingKeyCount?: number;
	/** Total env vars declared. Convenient for the pill text. */
	totalKeyCount?: number;
	/** Required/optional split so the card can render both pills. */
	requiredCount?: number;
	requiredMissingCount?: number;
	optionalCount?: number;
	optionalMissingCount?: number;
}

interface EnvVarRow {
	name: string;
	value: string;
	usedBy: string[];
	/** One-line description (from the skill's SKILL.md analysis). */
	description?: string;
	/** True when at least one skill using this var marks it required. */
	required?: boolean;
}

interface AriaSkillsState {
	defaults: SkillRow[];
	users: SkillRow[];
	categories: string[];
	envVars: EnvVarRow[];
	uvDetected: boolean;
	uvPath: string | null;
}

interface SectionRefs {
	countEl: HTMLElement;
	cardsContainer: HTMLElement;
	emptyEl: HTMLElement;
}

/**
 * Skills view — Step 7. Wires the search field and category dropdown
 * into the skill list filtering. Filter changes update `searchQuery`
 * / `categoryFilter`, then re-render only the affected skill sections
 * (count text + cards container). The toolbar, env panel, and uv badge
 * stay put — no root-level rebuild happens.
 */
export class AriaSkillsView extends ViewPane {

	static readonly ID = 'aria.skills.main';

	// Last state pulled from the extension. Cached so filter changes
	// can re-derive the list without another command round-trip.
	private latestState: AriaSkillsState | undefined;
	private searchQuery = '';
	private categoryFilter = '';

	private categorySelect: HTMLSelectElement | undefined;
	private defaultsRefs: SectionRefs | undefined;
	private usersRefs: SectionRefs | undefined;
	private envCountEl: HTMLElement | undefined;
	private envListContainer: HTMLElement | undefined;
	private envEmptyEl: HTMLElement | undefined;

	constructor(
		options: IViewPaneOptions,
		@IKeybindingService keybindingService: IKeybindingService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IConfigurationService configurationService: IConfigurationService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IViewDescriptorService viewDescriptorService: IViewDescriptorService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IOpenerService openerService: IOpenerService,
		@IThemeService themeService: IThemeService,
		@IHoverService hoverService: IHoverService,
		@ICommandService private readonly commandService: ICommandService,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);

		// Extension-fired refresh hook. The aria-skills first-run wizard
		// installs default skills behind the overlay, so this view's
		// onmount refresh has nothing yet — without this command call,
		// the user would have to click ↻ before seeing paper-lookup
		// land. Registered as a Disposable so a re-created pane doesn't
		// leave a stale callback pointing at a disposed view instance.
		this._register(CommandsRegistry.registerCommand('aria.skills.requestRefresh', () => {
			void this.refresh();
		}));
	}

	private viewBody: HTMLElement | undefined;

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);
		ensureAriaPaneScrollbarStyle();
		const root = append(container, $('div'));
		root.classList.add('aria-themed-scrollable');
		root.style.padding = '12px';
		root.style.color = 'var(--vscode-foreground)';
		root.style.fontSize = '12px';
		// Make the panel scrollable. Without these, anything past the
		// initial viewport just gets clipped — the user can't reach the
		// env vars section once a few skills land in the lists.
		root.style.boxSizing = 'border-box';
		root.style.overflowY = 'auto';
		root.style.overflowX = 'hidden';
		this.viewBody = root;

		const titleRow = append(root, $('div'));
		titleRow.style.display = 'flex';
		titleRow.style.alignItems = 'center';
		titleRow.style.justifyContent = 'space-between';
		titleRow.style.margin = '0 0 6px 0';

		const title = append(titleRow, $('h2'));
		title.style.fontSize = '13px';
		title.style.fontWeight = '600';
		title.style.margin = '0';
		title.textContent = 'Skills';

		const refreshBtn = append(titleRow, $('span.codicon.codicon-refresh')) as HTMLElement;
		refreshBtn.title = 'Refresh';
		refreshBtn.style.cursor = 'pointer';
		refreshBtn.style.opacity = '0.75';
		refreshBtn.style.padding = '2px 4px';
		refreshBtn.style.borderRadius = '3px';
		refreshBtn.onclick = () => { void this.refresh(); };

		const intro = append(root, $('p'));
		intro.style.opacity = '0.7';
		intro.style.margin = '0 0 12px 0';
		intro.style.fontSize = '11.5px';
		intro.textContent = 'Install and manage Claude skills, configure API keys, and approve which skills can run automatically.';

		const toolbar = append(root, $('div'));
		toolbar.style.display = 'flex';
		toolbar.style.flexDirection = 'column';
		toolbar.style.gap = '6px';
		toolbar.style.marginBottom = '12px';

		const searchInput = append(toolbar, $('input')) as HTMLInputElement;
		searchInput.type = 'search';
		searchInput.placeholder = 'Search skills...';
		this.styleInput(searchInput);
		searchInput.oninput = () => {
			this.searchQuery = searchInput.value;
			this.applyFiltersToSkillSections();
		};

		const categorySelect = append(toolbar, $('select')) as HTMLSelectElement;
		this.styleInput(categorySelect);
		const allOption = append(categorySelect, $('option')) as HTMLOptionElement;
		allOption.value = '';
		allOption.textContent = 'All categories';
		categorySelect.onchange = () => {
			this.categoryFilter = categorySelect.value;
			this.applyFiltersToSkillSections();
		};
		this.categorySelect = categorySelect;

		const addBtn = append(toolbar, $('button')) as HTMLButtonElement;
		addBtn.textContent = '+ Add Skill';
		this.stylePrimaryButton(addBtn);
		addBtn.onclick = () => {
			void this.commandService.executeCommand('aria.skills.addSkillStub');
		};

		this.defaultsRefs = this.renderCollapsibleSection(
			root, 'Default Skills', 'No default skills installed yet.',
		);
		this.usersRefs = this.renderCollapsibleSection(
			root, 'My Skills', 'No skills added yet. Click "+ Add Skill" above to add one from GitHub.',
		);

		const envSection = append(root, $('div'));
		envSection.style.marginBottom = '16px';

		const envHeader = append(envSection, $('div'));
		envHeader.style.display = 'flex';
		envHeader.style.alignItems = 'center';
		envHeader.style.gap = '6px';
		envHeader.style.userSelect = 'none';
		envHeader.style.padding = '4px 0';
		envHeader.style.fontWeight = '600';

		// Toggle target — only the chevron + label + count are
		// clickable so the "Open ~/.env" button on the right doesn't
		// double-fire the collapse handler.
		const envHeaderToggle = append(envHeader, $('div'));
		envHeaderToggle.style.display = 'flex';
		envHeaderToggle.style.alignItems = 'center';
		envHeaderToggle.style.gap = '6px';
		envHeaderToggle.style.flex = '1';
		envHeaderToggle.style.cursor = 'pointer';

		const envChevron = append(envHeaderToggle, $('span'));
		envChevron.style.fontSize = '10px';
		envChevron.textContent = '▾';

		const envLabel = append(envHeaderToggle, $('span'));
		envLabel.textContent = 'Environment Variables';

		const envCount = append(envHeaderToggle, $('span'));
		envCount.style.opacity = '0.6';
		envCount.style.fontWeight = 'normal';
		envCount.textContent = '(0)';
		this.envCountEl = envCount;

		// "Open ~/.env" lives on the right edge of the header — close
		// to the section title it acts on. Stops propagation so the
		// outer toggle doesn't fire when the user just wants the file.
		const openEnvHeaderBtn = append(envHeader, $('button')) as HTMLButtonElement;
		openEnvHeaderBtn.textContent = 'Open ~/.env';
		openEnvHeaderBtn.style.background = 'transparent';
		openEnvHeaderBtn.style.color = 'var(--vscode-foreground)';
		openEnvHeaderBtn.style.border = '1px solid var(--vscode-button-border, var(--vscode-foreground))';
		openEnvHeaderBtn.style.padding = '2px 8px';
		openEnvHeaderBtn.style.borderRadius = '3px';
		openEnvHeaderBtn.style.cursor = 'pointer';
		openEnvHeaderBtn.style.fontSize = '10.5px';
		openEnvHeaderBtn.style.fontFamily = 'inherit';
		openEnvHeaderBtn.style.opacity = '0.85';
		openEnvHeaderBtn.style.fontWeight = 'normal';
		openEnvHeaderBtn.onclick = (e) => {
			e.stopPropagation();
			void this.commandService.executeCommand('aria.skills.openEnvFile');
		};

		const envBody = append(envSection, $('div'));
		envBody.style.display = 'block';
		envBody.style.marginTop = '4px';

		const envList = append(envBody, $('div'));
		envList.style.display = 'none';
		envList.style.flexDirection = 'column';
		envList.style.gap = '6px';
		this.envListContainer = envList;

		const envEmpty = append(envBody, $('div'));
		envEmpty.textContent = 'No environment variables required by installed skills.';
		this.styleEmpty(envEmpty);
		this.envEmptyEl = envEmpty;

		// uv install status removed from the sidebar — the first-run
		// wizard installs uv automatically and the user can verify by
		// running `uv --version` in a terminal if they need to.
		// `Open ~/.env` moved to the header for proximity to the title.

		envHeaderToggle.onclick = () => {
			const collapsed = envBody.style.display === 'none';
			envBody.style.display = collapsed ? 'block' : 'none';
			envChevron.textContent = collapsed ? '▾' : '▸';
		};

		void this.refresh();
	}

	protected override layoutBody(height: number, width: number): void {
		super.layoutBody(height, width);
		// Pin the scrollable root to the pane's measured size so the
		// browser knows where the overflow boundary is — without an
		// explicit height the inner div grows past the visible area and
		// scrollbars never engage.
		if (this.viewBody) {
			this.viewBody.style.height = `${height}px`;
			this.viewBody.style.width = `${width}px`;
		}
	}

	private async refresh(): Promise<void> {
		let state: AriaSkillsState | undefined;
		try {
			state = await this.commandService.executeCommand<AriaSkillsState>('aria.skills.getState');
		} catch {
			// extension still booting
		}
		if (!state) {
			return;
		}
		this.latestState = state;

		this.syncCategoryOptions(state.categories);
		this.applyFiltersToSkillSections();
		this.applyEnvState(state.envVars);
	}

	/**
	 * Keep the category dropdown in sync with the extension's category
	 * list. We rebuild the option set in-place rather than clearing the
	 * select element entirely — the select itself stays put, only its
	 * children change. That's safe because the select sits inside the
	 * toolbar, not at root level.
	 */
	private syncCategoryOptions(categories: string[]): void {
		const sel = this.categorySelect;
		if (!sel) {
			return;
		}
		// Preserve the current pick across the rebuild, fall back to ""
		// when the previous category disappears from the list.
		const previous = this.categoryFilter;
		clearNode(sel);
		const allOption = append(sel, $('option')) as HTMLOptionElement;
		allOption.value = '';
		allOption.textContent = 'All categories';
		for (const c of categories) {
			const opt = append(sel, $('option')) as HTMLOptionElement;
			opt.value = c;
			opt.textContent = c;
			if (c === previous) {
				opt.selected = true;
			}
		}
		if (!categories.includes(previous)) {
			this.categoryFilter = '';
		}
	}

	/**
	 * Recompute the visible skill list using the current search query +
	 * category filter, then push the result into each section's cards
	 * container. State-cache driven so filter changes don't trigger
	 * another extension round-trip.
	 */
	private applyFiltersToSkillSections(): void {
		const state = this.latestState;
		const defaults = state ? this.filterSkills(state.defaults) : [];
		const users = state ? this.filterSkills(state.users) : [];
		this.applySectionState(this.defaultsRefs, defaults);
		this.applySectionState(this.usersRefs, users);
	}

	private filterSkills(skills: SkillRow[]): SkillRow[] {
		const q = this.searchQuery.trim().toLowerCase();
		return skills.filter(s => {
			if (this.categoryFilter && s.category !== this.categoryFilter) {
				return false;
			}
			if (q) {
				const hay = (s.name + ' ' + (s.description || '')).toLowerCase();
				if (!hay.includes(q)) {
					return false;
				}
			}
			return true;
		});
	}

	private applySectionState(refs: SectionRefs | undefined, skills: SkillRow[]): void {
		if (!refs) {
			return;
		}
		refs.countEl.textContent = `(${skills.length})`;
		if (skills.length === 0) {
			refs.cardsContainer.style.display = 'none';
			refs.emptyEl.style.display = 'block';
			return;
		}
		refs.emptyEl.style.display = 'none';
		refs.cardsContainer.style.display = 'flex';
		clearNode(refs.cardsContainer);
		for (const skill of skills) {
			this.renderSkillCard(refs.cardsContainer, skill);
		}
	}

	private applyEnvState(envVars: EnvVarRow[]): void {
		if (this.envCountEl) {
			this.envCountEl.textContent = `(${envVars.length})`;
		}
		if (!this.envListContainer || !this.envEmptyEl) {
			return;
		}
		if (envVars.length === 0) {
			this.envListContainer.style.display = 'none';
			this.envEmptyEl.style.display = 'block';
			return;
		}
		this.envEmptyEl.style.display = 'none';
		this.envListContainer.style.display = 'flex';
		clearNode(this.envListContainer);

		// Split by required vs optional so the user sees which keys the
		// installed skills actually depend on. A variable counts as
		// required when any of its consuming skills marks it so.
		const required = envVars.filter(v => v.required);
		const optional = envVars.filter(v => !v.required);

		if (required.length > 0) {
			this.renderEnvSubgroup(this.envListContainer, 'Required', required);
		}
		if (optional.length > 0) {
			this.renderEnvSubgroup(this.envListContainer, 'Optional', optional);
		}
	}

	private renderEnvSubgroup(parent: HTMLElement, label: string, rows: EnvVarRow[]): void {
		const group = append(parent, $('div'));
		group.style.display = 'flex';
		group.style.flexDirection = 'column';
		group.style.gap = '6px';
		group.style.marginBottom = '8px';

		const heading = append(group, $('div'));
		heading.style.fontSize = '11px';
		heading.style.fontWeight = '600';
		heading.style.opacity = '0.7';
		heading.style.textTransform = 'uppercase';
		heading.style.letterSpacing = '0.5px';
		heading.textContent = `${label} (${rows.length})`;

		for (const v of rows) {
			this.renderEnvVarRow(group, v);
		}
	}

	private renderSkillCard(parent: HTMLElement, skill: SkillRow): void {
		const card = append(parent, $('div'));
		card.style.background = 'var(--vscode-editorWidget-background, rgba(127,127,127,0.06))';
		card.style.border = '1px solid var(--vscode-panel-border, rgba(127,127,127,0.18))';
		card.style.borderRadius = '4px';
		card.style.padding = '8px 10px';
		card.style.display = 'flex';
		card.style.flexDirection = 'column';
		card.style.gap = '4px';

		// Title row: skill name on the left, lock/unlock permission badge
		// on the right. We mount the permission control here (not at the
		// bottom of the card) so it sits at the right edge of the same
		// horizontal line as the title, matching the design direction
		// from the user.
		//
		// `flex-wrap: wrap` makes the badge drop to a new row when the
		// pane is too narrow to fit it on the title line — otherwise
		// flexbox shrinks the badge and clips its label ("Manual" →
		// "Mar"). The name field stays on the first line because it
		// claims the available width with flex-grow.
		const titleRow = append(card, $('div'));
		titleRow.style.display = 'flex';
		titleRow.style.alignItems = 'center';
		titleRow.style.justifyContent = 'space-between';
		titleRow.style.gap = '8px';
		titleRow.style.flexWrap = 'wrap';

		const name = append(titleRow, $('span'));
		name.style.fontWeight = '600';
		name.style.flex = '1 1 auto';
		name.style.minWidth = '0';
		name.style.overflow = 'hidden';
		name.style.textOverflow = 'ellipsis';
		name.style.whiteSpace = 'nowrap';
		name.textContent = skill.name;

		this.renderPermissionBadge(titleRow, skill);

		const metaRow = append(card, $('div'));
		metaRow.style.display = 'flex';
		metaRow.style.gap = '4px';
		metaRow.style.flexWrap = 'wrap';
		metaRow.style.alignItems = 'center';
		metaRow.style.fontSize = '11px';

		const catPill = append(metaRow, $('span'));
		this.stylePill(catPill, false);
		catPill.textContent = skill.category || 'Other';

		// Required + optional get their own pills so the user can tell
		// at a glance whether the skill is usable right now. Required
		// pill turns green when every required key is filled (skill
		// works); optional pill stays neutral because the skill still
		// works without the extras.
		const total = skill.totalKeyCount ?? skill.envVars.length;
		const requiredCount = skill.requiredCount ?? skill.envVars.filter(v => v.required).length;
		const optionalCount = skill.optionalCount ?? skill.envVars.filter(v => !v.required).length;
		const requiredMissing = skill.requiredMissingCount ?? requiredCount;
		const optionalMissing = skill.optionalMissingCount ?? optionalCount;

		if (total === 0) {
			const pill = append(metaRow, $('span'));
			this.stylePill(pill, false);
			pill.textContent = 'No key needed';
		} else {
			// Both pills read as "filled / total" so the fraction means
			// the same thing on both sides. "0/1 required missing" is
			// 0 of 1 filled (the user reads "0 done out of 1 needed").
			if (requiredCount > 0) {
				const reqPill = append(metaRow, $('span'));
				const filledRequired = requiredCount - requiredMissing;
				if (requiredMissing === 0) {
					this.stylePill(reqPill, false);
					reqPill.style.background = 'rgba(80, 180, 100, 0.18)';
					reqPill.style.color = 'rgb(80, 180, 100)';
					reqPill.textContent = `${filledRequired}/${requiredCount} required ✓`;
				} else {
					this.stylePill(reqPill, true);
					reqPill.textContent = `${filledRequired}/${requiredCount} required missing`;
				}
			}
			if (optionalCount > 0) {
				const optPill = append(metaRow, $('span'));
				this.stylePill(optPill, false);
				const filledOptional = optionalCount - optionalMissing;
				optPill.textContent = filledOptional === optionalCount
					? `${filledOptional}/${optionalCount} optional ✓`
					: `${filledOptional}/${optionalCount} optional`;
			}
		}

		// "Configure keys" affordance. Visible whenever the skill
		// declares any env vars — the user might want to update an
		// existing value, not just fill the first one.
		const missing = requiredMissing + optionalMissing;
		if (total > 0) {
			const configBtn = append(metaRow, $('button')) as HTMLButtonElement;
			configBtn.textContent = missing > 0 ? 'Enter keys' : 'Edit keys';
			configBtn.style.background = 'transparent';
			configBtn.style.color = 'var(--vscode-foreground)';
			configBtn.style.border = '1px solid var(--vscode-button-border, var(--vscode-foreground))';
			configBtn.style.padding = '2px 8px';
			configBtn.style.borderRadius = '3px';
			configBtn.style.cursor = 'pointer';
			configBtn.style.fontSize = '10.5px';
			configBtn.style.opacity = '0.85';
			configBtn.onclick = (e) => {
				e.stopPropagation();
				void this.commandService.executeCommand('aria.skills.configureKeys', skill.name);
			};
		}

		if (skill.description) {
			const desc = append(card, $('div'));
			desc.style.fontSize = '11.5px';
			desc.style.opacity = '0.8';
			desc.style.display = '-webkit-box';
			desc.style.webkitLineClamp = '3';
			(desc.style as unknown as Record<string, string>)['webkit-line-clamp'] = '3';
			desc.style.webkitBoxOrient = 'vertical';
			(desc.style as unknown as Record<string, string>)['-webkit-box-orient'] = 'vertical';
			desc.style.overflow = 'hidden';
			desc.style.cursor = 'pointer';
			desc.title = skill.description;
			desc.textContent = skill.description;
			// Tap to expand the description in-place rather than forcing
			// the user to read a hover tooltip on a narrow sidebar.
			let expanded = false;
			desc.onclick = () => {
				expanded = !expanded;
				if (expanded) {
					desc.style.webkitLineClamp = 'unset';
					(desc.style as unknown as Record<string, string>)['webkit-line-clamp'] = 'unset';
				} else {
					desc.style.webkitLineClamp = '3';
					(desc.style as unknown as Record<string, string>)['webkit-line-clamp'] = '3';
				}
			};
		}

		// Per-card management buttons (uninstall). User skills get a
		// trash icon; defaults don't (re-running the first-run wizard is
		// the supported path for those).
		if (skill.type === 'user') {
			const manageRow = append(card, $('div'));
			manageRow.style.display = 'flex';
			manageRow.style.justifyContent = 'flex-end';
			manageRow.style.marginTop = '4px';

			const uninstallBtn = append(manageRow, $('button')) as HTMLButtonElement;
			uninstallBtn.textContent = 'Uninstall';
			uninstallBtn.style.background = 'transparent';
			uninstallBtn.style.color = 'rgb(220, 100, 100)';
			uninstallBtn.style.border = '1px solid rgba(220, 100, 100, 0.4)';
			uninstallBtn.style.padding = '2px 8px';
			uninstallBtn.style.borderRadius = '3px';
			uninstallBtn.style.cursor = 'pointer';
			uninstallBtn.style.fontSize = '10.5px';
			uninstallBtn.style.opacity = '0.85';
			uninstallBtn.onclick = (e) => {
				e.stopPropagation();
				void this.commandService.executeCommand('aria.skills.uninstallSkill', skill.name);
			};
		}
	}

	/**
	 * Lock/unlock pill rendered at the right edge of each skill card's
	 * title row. Click toggles between Manual (locked, gray) and Auto
	 * (unlocked, green). The icon-plus-label combo carries the meaning
	 * the previous long sentence used to spell out, in much less space.
	 */
	private renderPermissionBadge(parent: HTMLElement, skill: SkillRow): void {
		const badge = append(parent, $('span'));
		badge.style.cursor = 'pointer';
		badge.style.fontSize = '10.5px';
		badge.style.display = 'inline-flex';
		badge.style.alignItems = 'center';
		badge.style.gap = '4px';
		badge.style.padding = '2px 8px';
		badge.style.borderRadius = '4px';
		badge.style.userSelect = 'none';
		// Never shrink the badge — if the panel is too narrow, the
		// parent's `flex-wrap: wrap` will drop the badge to a new
		// row rather than clipping the label.
		badge.style.flexShrink = '0';
		badge.style.whiteSpace = 'nowrap';

		let current = !!skill.autoApprove;
		const paint = (): void => {
			clearNode(badge);
			const icon = append(badge, $(current
				? 'span.codicon.codicon-unlock'
				: 'span.codicon.codicon-lock')) as HTMLElement;
			icon.style.fontSize = '12px';
			const label = append(badge, $('span'));
			label.textContent = current ? 'Auto' : 'Manual';
			if (current) {
				badge.style.background = 'rgba(80, 180, 100, 0.2)';
				badge.style.color = 'rgb(80, 180, 100)';
				badge.title = 'Auto-approved: Claude can use this skill without asking. Click to require approval.';
			} else {
				badge.style.background = 'rgba(127, 127, 127, 0.18)';
				badge.style.color = 'var(--vscode-foreground)';
				badge.title = 'Manual: Claude asks before using this skill. Click to auto-approve.';
			}
		};
		paint();

		badge.onclick = () => {
			current = !current;
			paint();
			void this.commandService.executeCommand('aria.skills.toggleAutoApprove', skill.name);
		};
	}

	private renderEnvVarRow(parent: HTMLElement, v: EnvVarRow): void {
		const row = append(parent, $('div'));
		row.style.padding = '6px 0';
		row.style.borderBottom = '1px solid rgba(127,127,127,0.12)';
		row.style.display = 'flex';
		row.style.flexDirection = 'column';
		row.style.gap = '4px';

		// Top line: NAME: ••••• [✎ Edit]
		// Edit button sits on the right, name+value occupy the left
		// flex region. Both name and value get an ellipsis treatment so
		// a long key (or a long masked value) can't shove the Edit
		// button out of the panel.
		const top = append(row, $('div'));
		top.style.display = 'flex';
		top.style.alignItems = 'center';
		top.style.gap = '8px';

		const nameValue = append(top, $('span'));
		nameValue.style.flex = '1 1 auto';
		nameValue.style.minWidth = '0';
		nameValue.style.overflow = 'hidden';
		nameValue.style.whiteSpace = 'nowrap';
		nameValue.style.textOverflow = 'ellipsis';
		nameValue.style.fontSize = '11.5px';

		const nameEl = append(nameValue, $('span'));
		nameEl.style.fontWeight = '600';
		nameEl.textContent = `${v.name}: `;

		const valueEl = append(nameValue, $('span'));
		valueEl.style.fontFamily = 'var(--vscode-editor-font-family, monospace)';
		valueEl.style.opacity = v.value ? '0.85' : '0.4';
		// Cap the visible mask at 10 dots so it never crowds the Edit
		// button on narrow panes. The real value length is still
		// reflected by the Edit dialog when the user opens it.
		valueEl.textContent = v.value
			? '•'.repeat(Math.min(v.value.length, 10))
			: '(not set)';

		const editBtn = append(top, $('button')) as HTMLButtonElement;
		editBtn.style.background = 'transparent';
		editBtn.style.color = 'var(--vscode-foreground)';
		editBtn.style.border = '1px solid var(--vscode-button-border, var(--vscode-foreground))';
		editBtn.style.padding = '2px 8px';
		editBtn.style.borderRadius = '3px';
		editBtn.style.cursor = 'pointer';
		editBtn.style.opacity = '0.85';
		editBtn.style.display = 'inline-flex';
		editBtn.style.alignItems = 'center';
		editBtn.style.gap = '4px';
		editBtn.style.fontFamily = 'inherit';
		editBtn.style.fontSize = '10.5px';
		editBtn.style.flexShrink = '0';
		editBtn.title = 'Edit value';
		const icon = append(editBtn, $('span.codicon.codicon-edit')) as HTMLElement;
		icon.style.fontSize = '11px';
		const editText = append(editBtn, $('span'));
		editText.textContent = 'Edit';
		// Await the input box so we can repaint the masked value
		// immediately after the user saves — otherwise the old mask
		// hangs around until they hit the section refresh icon.
		editBtn.onclick = async (e) => {
			e.stopPropagation();
			await this.commandService.executeCommand('aria.skills.editEnvVar', v.name);
			void this.refresh();
		};

		// Optional one-line description, sourced from the skill's
		// SKILL.md analysis. Shown above "Used by:" so the user has
		// context before they decide whether to update the key.
		if (v.description) {
			const desc = append(row, $('div'));
			desc.style.opacity = '0.75';
			desc.style.fontSize = '11px';
			desc.style.paddingLeft = '2px';
			desc.style.lineHeight = '1.4';
			desc.style.whiteSpace = 'normal';
			desc.textContent = v.description;
		}

		const usedBy = append(row, $('div'));
		usedBy.style.opacity = '0.6';
		usedBy.style.fontSize = '11px';
		usedBy.style.paddingLeft = '2px';
		usedBy.textContent = `Used by: ${v.usedBy.join(', ')}`;
	}

	private renderCollapsibleSection(
		root: HTMLElement,
		label: string,
		emptyText: string,
	): SectionRefs {
		const section = append(root, $('div'));
		section.style.marginBottom = '16px';

		const header = append(section, $('div'));
		header.style.display = 'flex';
		header.style.alignItems = 'center';
		header.style.gap = '6px';
		header.style.cursor = 'pointer';
		header.style.userSelect = 'none';
		header.style.padding = '4px 0';
		header.style.fontWeight = '600';

		const chevron = append(header, $('span'));
		chevron.style.fontSize = '10px';
		chevron.textContent = '▾';

		const labelEl = append(header, $('span'));
		labelEl.textContent = label;

		const countEl = append(header, $('span'));
		countEl.style.opacity = '0.6';
		countEl.style.fontWeight = 'normal';
		countEl.textContent = '(0)';

		const body = append(section, $('div'));
		body.style.display = 'block';
		body.style.marginTop = '4px';

		const cardsContainer = append(body, $('div'));
		cardsContainer.style.display = 'none';
		cardsContainer.style.flexDirection = 'column';
		cardsContainer.style.gap = '6px';

		const empty = append(body, $('div'));
		empty.textContent = emptyText;
		this.styleEmpty(empty);

		header.onclick = () => {
			const collapsed = body.style.display === 'none';
			body.style.display = collapsed ? 'block' : 'none';
			chevron.textContent = collapsed ? '▾' : '▸';
		};

		return { countEl, cardsContainer, emptyEl: empty };
	}

	private styleInput(el: HTMLInputElement | HTMLSelectElement): void {
		el.style.background = 'var(--vscode-input-background)';
		el.style.color = 'var(--vscode-input-foreground)';
		el.style.border = '1px solid var(--vscode-input-border, transparent)';
		el.style.padding = '4px 8px';
		el.style.fontSize = '12px';
		el.style.borderRadius = '3px';
		el.style.fontFamily = 'inherit';
	}

	private stylePrimaryButton(btn: HTMLButtonElement): void {
		btn.style.background = 'var(--vscode-button-background)';
		btn.style.color = 'var(--vscode-button-foreground)';
		btn.style.border = 'none';
		btn.style.padding = '5px 12px';
		btn.style.borderRadius = '3px';
		btn.style.cursor = 'pointer';
		btn.style.fontSize = '12px';
		btn.style.fontFamily = 'inherit';
	}

	private stylePill(el: HTMLElement, warn: boolean): void {
		el.style.padding = '1px 6px';
		el.style.borderRadius = '8px';
		el.style.fontSize = '10.5px';
		if (warn) {
			el.style.background = 'rgba(220, 150, 50, 0.2)';
			el.style.color = 'rgb(220, 150, 50)';
		} else {
			el.style.background = 'rgba(127, 127, 127, 0.18)';
		}
	}

	private styleEmpty(el: HTMLElement): void {
		el.style.padding = '12px';
		el.style.textAlign = 'center';
		el.style.opacity = '0.55';
		el.style.fontSize = '11.5px';
		el.style.background = 'rgba(127,127,127,0.05)';
		el.style.border = '1px dashed rgba(127,127,127,0.2)';
		el.style.borderRadius = '4px';
	}
}
