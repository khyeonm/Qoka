/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { EditorInput } from '../../../common/editor/editorInput.js';
import { EditorInputCapabilities, IUntypedEditorInput } from '../../../common/editor.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { ROADMAP_SCHEME } from './ariaRoadmapWizardCommon.js';

/**
 * Editor input for a roadmap canvas.
 *
 * It carries no document of its own — the authoritative roadmap lives in
 * the aria-roadmap extension and is streamed to the pane via the
 * `onDidChangeRoadmapState` signal. The input exists only so a roadmap
 * can occupy the editor area like any other built-in editor (Welcome,
 * Settings, …) rather than a hand-rolled overlay.
 *
 * A project holds MANY roadmaps (one per hypothesis), so the input is keyed
 * by `roadmapId` — one tab per roadmap, and re-opening the same roadmap
 * focuses its existing tab. We deliberately register NO serializer, so tabs
 * are not restored across window reloads; the sidebar re-opens them on demand.
 */
export class AriaRoadmapEditorInput extends EditorInput {

	static readonly ID = 'aria.roadmap.editorInput';

	constructor(
		readonly roadmapId: string,
		private readonly displayName: string,
	) {
		super();
	}

	override get typeId(): string {
		return AriaRoadmapEditorInput.ID;
	}

	override get editorId(): string | undefined {
		return AriaRoadmapEditorInput.ID;
	}

	override get capabilities(): EditorInputCapabilities {
		return EditorInputCapabilities.Singleton;
	}

	override get resource(): URI {
		return URI.from({ scheme: ROADMAP_SCHEME, path: `/roadmap/${this.roadmapId}` });
	}

	override getName(): string {
		return this.displayName || localize('aria.roadmap.editorName', "Roadmap");
	}

	override matches(other: EditorInput | IUntypedEditorInput): boolean {
		if (super.matches(other)) {
			return true;
		}
		return other instanceof AriaRoadmapEditorInput && other.roadmapId === this.roadmapId;
	}
}
