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
 * Editor input for the New Project Roadmap Wizard.
 *
 * It carries no document of its own — the authoritative roadmap lives in
 * the aria-roadmap extension and is streamed to the pane via the
 * `onDidChangeRoadmapState` signal. The input exists only so the wizard
 * can occupy the editor area like any other built-in editor (Welcome,
 * Settings, …) rather than a hand-rolled overlay.
 *
 * `Singleton` keeps a single wizard tab — re-opening focuses the existing
 * one. We deliberately register NO serializer for this input, so it is not
 * restored across window reloads: the wizard is a transient drafting
 * surface for an empty workspace, and after Save the window reloads into
 * the freshly-created project folder where the wizard has no place.
 */
export class AriaRoadmapEditorInput extends EditorInput {

	static readonly ID = 'aria.roadmap.editorInput';
	static readonly RESOURCE = URI.from({ scheme: ROADMAP_SCHEME, path: '/wizard' });

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
		return AriaRoadmapEditorInput.RESOURCE;
	}

	override getName(): string {
		return localize('aria.roadmap.editorName', "New Project — Roadmap");
	}

	override matches(other: EditorInput | IUntypedEditorInput): boolean {
		if (super.matches(other)) {
			return true;
		}
		return other instanceof AriaRoadmapEditorInput;
	}
}
