/**
 * The open editor's imperative surface, deliberately CodeMirror-free so a
 * host can coordinate mutations without importing the editor stack.
 *
 * Whole-file writes from board state can lag the live document (the board
 * mirror is debounced); every mutation of an OPEN file must instead read or
 * transform the live doc through this API, exactly like the Yjs board
 * mutated the shared Y.Text.
 */
export interface CollabEditorApi {
  /** Workspace-relative path of the live document. */
  path: string;
  /** False once the session can never sync again (ended / disconnected /
   * over-cap). A dead view still renders its text, but treating it as live
   * would swallow mutations (dispatches never push) and leak its stale text
   * into write lanes — dead means route around this API entirely. */
  isLive(): boolean;
  /** The live document text, synchronously. */
  source(): string;
  /** The caret position (doc offset), synchronously. */
  selectionHead(): number;
  /** Push any unconfirmed local edits (one quiet try) and resolve when the
   * attempt finished — rename lanes await this before reading the old
   * session's head, so the carry can't race the final keystrokes. */
  flushPending(): Promise<void>;
  /** Apply `transform` to the live doc as a minimal splice (concurrent
   * edits outside the changed region survive; the redline stays truthful). */
  applyTransform(transform: (source: string) => string): void;
  /** Insert text at the caret (replacing any selection), caret after it,
   * and focus the editor — the `+` menu's way in. */
  insert(text: string): void;
  /** Open the completion list at the caret (after inserting a trigger). */
  startCompletion(): void;
}
