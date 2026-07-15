/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { EditorInput } from '../../../common/editor/editorInput.js';
import { IUntypedEditorInput } from '../../../common/editor.js';
import { URI } from '../../../../base/common/uri.js';
import { basename, isEqual } from '../../../../base/common/resources.js';
import { localize } from '../../../../nls.js';

/** Synthetic scheme for the note editor input's identity URI. Using a real
 *  `file:` resource here would make VS Code open the note's JSON in the default
 *  text editor instead of our BlockNote pane - the same reason the roadmap
 *  wizard uses its own `aria-roadmap:` scheme. The real file is `fileResource`. */
export const ARIA_NOTE_SCHEME = 'aria-note';

/**
 * Editor input for a research note. Backed by a real file
 * (`<workspace>/notes/<id>.json`, a BlockNote document in `fileResource`) but
 * identified to the editor service by a synthetic `aria-note:` URI so it opens
 * with the BlockNote webview pane rather than the JSON text editor.
 */
export class AriaNoteEditorInput extends EditorInput {

	static readonly ID = 'aria.notes.editorInput';
	static readonly EDITOR_ID = 'aria.notes.editorPane';

	private readonly _resource: URI;
	private _name: string;

	constructor(readonly fileResource: URI) {
		super();
		this._resource = URI.from({ scheme: ARIA_NOTE_SCHEME, path: fileResource.path, query: fileResource.scheme });
		this._name = basename(fileResource).replace(/\.json$/, '') || localize('aria.notes.untitled', "Note");
	}

	override get typeId(): string {
		return AriaNoteEditorInput.ID;
	}

	override get editorId(): string | undefined {
		return AriaNoteEditorInput.EDITOR_ID;
	}

	override get resource(): URI {
		return this._resource;
	}

	override getName(): string {
		return this._name;
	}

	/** Update the tab title (called by the pane once it reads the note's title). */
	setName(name: string): void {
		if (name && name !== this._name) {
			this._name = name;
			this._onDidChangeLabel.fire();
		}
	}

	override matches(other: EditorInput | IUntypedEditorInput): boolean {
		if (super.matches(other)) {
			return true;
		}
		return other instanceof AriaNoteEditorInput && isEqual(other.fileResource, this.fileResource);
	}
}
