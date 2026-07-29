// annotated-markdown: a standalone codec for iterate-style markdown — YAML
// front matter, an ordinary markdown body, and discussion threads stored at
// the end of the file between paired HTML-comment sentinels. Parsing is
// transactional and fail-open (structural doubt returns the whole file as a
// plain document, byte-for-byte); edits are minimal source splices. The
// grammar and its invariants are documented in README.md next to this file.

export { parseAnnotatedMarkdown } from "./parse.ts";
export { projectMarkdownPreview } from "./preview.ts";
export type { MarkdownPreviewProjection } from "./preview.ts";
export {
  addComment,
  addThread,
  AnnotatedMarkdownEditError,
  deleteComment,
  editComment,
  formatUtcTimestamp,
  removeThread,
  setThreadAnchor,
  setThreadStatus,
} from "./edits.ts";
export type {
  AddCommentOptions,
  AddCommentResult,
  AddThreadOptions,
  AddThreadResult,
  EditErrorCode,
} from "./edits.ts";
export { createAnchorSelector, findInlineMarker, resolveThreadAnchor } from "./anchors.ts";
export { isValidAuthor } from "./sentinels.ts";
export type { AnchorResolution, AnchorState } from "./anchors.ts";
export { newCommentId, newThreadId, ulid } from "./ulid.ts";
export type {
  AnchorSelector,
  Diagnostic,
  DiagnosticCode,
  Discussion,
  EditResult,
  Frontmatter,
  ParseResult,
  PlainDocument,
  SourceRange,
  Splice,
  StructuredDocument,
  Thread,
  ThreadAnchor,
  ThreadComment,
} from "./types.ts";
