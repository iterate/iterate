/**
 * The open editor's imperative surface, exposed to the board route via a ref
 * — deliberately CM-free so the board bundle never imports the editor stack.
 *
 * Whole-file writes from board state can lag the live document (the board
 * mirror is debounced); every mutation of an OPEN file must instead read or
 * transform the live doc through this API, exactly like the Yjs board
 * mutated the shared Y.Text.
 */
export interface CollabEditorApi {
  /** Repo-relative path of the live document. */
  path: string;
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
}
