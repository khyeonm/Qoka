/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { EditorInput } from '../../../common/editor/editorInput.js';
import { IUntypedEditorInput } from '../../../common/editor.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';

/** Synthetic scheme so a review opens in our custom pane. */
export const ARIA_REVIEW_SCHEME = 'aria-review';

/**
 * Editor input for the AI Peer Review tab. `execId === undefined` is the "new
 * review" input (shows the attach/run form); an execId opens an existing review
 * run stored at `<workspace>/reviews/<execId>/`.
 */
export class AriaPeerReviewInput extends EditorInput {

	static readonly ID = 'aria.peerReview.editorInput';
	static readonly EDITOR_ID = 'aria.peerReview.editorPane';

	private readonly _resource: URI;
	private _name: string;

	constructor(readonly execId: string | undefined) {
		super();
		this._resource = URI.from({ scheme: ARIA_REVIEW_SCHEME, path: '/' + (execId ?? 'new') });
		this._name = execId
			? localize('aria.peerReview.reviewName', "Review")
			: localize('aria.peerReview.newName', "New Review");
	}

	override get typeId(): string { return AriaPeerReviewInput.ID; }
	override get editorId(): string | undefined { return AriaPeerReviewInput.EDITOR_ID; }
	override get resource(): URI { return this._resource; }
	override getName(): string { return this._name; }

	/** Update the tab title once the pane reads the review's paper title. */
	setName(name: string): void {
		if (name && name !== this._name) {
			this._name = name;
			this._onDidChangeLabel.fire();
		}
	}

	override matches(other: EditorInput | IUntypedEditorInput): boolean {
		if (super.matches(other)) { return true; }
		return other instanceof AriaPeerReviewInput && other.execId === this.execId;
	}
}
