import { resolveThreadAnchor } from "./anchors.ts";
import { parseAnnotatedMarkdown } from "./parse.ts";
import {
  formatAnchorSentinel,
  formatCommentBegin,
  formatCommentEnd,
  formatStoreSentinel,
  formatThreadBegin,
  formatThreadEnd,
  isValidAuthor,
  isValidCreatedAt,
  isValidId,
  parseSentinelLine,
  validateAnchorSelector,
} from "./sentinels.ts";
import { newCommentId, newThreadId } from "./ulid.ts";
import type {
  AnchorSelector,
  EditResult,
  Splice,
  SourceRange,
  StructuredDocument,
  Thread,
  ThreadComment,
} from "./types.ts";

// Edit operations are minimal source splices: they never re-serialize the
// document, so every byte outside the spliced ranges is preserved exactly.
// Each operation applies its splices, re-runs the strict parser, and refuses
// to succeed unless the result is fully structured again.

export type EditErrorCode =
  | "unknown-thread"
  | "unknown-comment"
  | "comment-deleted"
  | "invalid-author"
  | "invalid-created"
  | "invalid-id"
  | "duplicate-id"
  | "invalid-body"
  | "invalid-label"
  | "invalid-anchor"
  | "invalid-reply-target"
  | "edit-produced-invalid-document";

export class AnnotatedMarkdownEditError extends Error {
  readonly code: EditErrorCode;
  constructor(code: EditErrorCode, message: string) {
    super(message);
    this.name = "AnnotatedMarkdownEditError";
    this.code = code;
  }
}

const fail = (code: EditErrorCode, message: string): never => {
  throw new AnnotatedMarkdownEditError(code, message);
};

export function formatUtcTimestamp(iso: string): string {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})/.exec(iso);
  if (match === null) return iso;
  return `${match[1]} ${match[2]}:${match[3]} UTC`;
}

function dominantEol(raw: string): "\n" | "\r\n" {
  let crlf = 0;
  let lf = 0;
  for (let i = raw.indexOf("\n"); i !== -1; i = raw.indexOf("\n", i + 1)) {
    if (raw[i - 1] === "\r") crlf++;
    else lf++;
  }
  return crlf > lf ? "\r\n" : "\n";
}

function applySplices(raw: string, splices: Splice[]): string {
  const sorted = [...splices].sort((a, b) => a.range.start - b.range.start);
  let out = "";
  let cursor = 0;
  for (const splice of sorted) {
    if (splice.range.start < cursor || splice.range.end < splice.range.start) {
      throw new Error("overlapping or inverted splices");
    }
    out += raw.slice(cursor, splice.range.start) + splice.insert;
    cursor = splice.range.end;
  }
  return out + raw.slice(cursor);
}

function finish(doc: StructuredDocument, splices: Splice[]): EditResult {
  const raw = applySplices(doc.raw, splices);
  const next = parseAnnotatedMarkdown(raw);
  if (next.kind !== "structured") {
    return fail(
      "edit-produced-invalid-document",
      `edit produced an invalid document: ${next.diagnostics[0]?.message ?? "unknown reason"}`,
    );
  }
  return { doc: next, raw, splices: [...splices].sort((a, b) => a.range.start - b.range.start) };
}

/** Number of consecutive line endings immediately before `pos`. */
function newlinesBefore(raw: string, pos: number): number {
  let count = 0;
  let i = pos;
  while (i > 0 && raw[i - 1] === "\n") {
    i--;
    if (raw[i - 1] === "\r") i--;
    count++;
  }
  return count;
}

/** Padding so an inserted block is separated from what precedes it by one blank line. */
function blockPadding(raw: string, pos: number, eol: string): string {
  if (pos === 0) return "";
  return eol.repeat(Math.max(0, 2 - newlinesBefore(raw, pos)));
}

/** Start offset of the last line of `range` (the end-sentinel line of a block). */
function startOfLastLine(raw: string, range: SourceRange): number {
  let i = range.end;
  if (raw[i - 1] === "\n") {
    i--;
    if (raw[i - 1] === "\r") i--;
  }
  return raw.lastIndexOf("\n", i - 1) + 1;
}

/** Extend a block range forward over one trailing blank line, if present. */
function withTrailingBlankLine(raw: string, range: SourceRange): SourceRange {
  let end = range.end;
  if (raw.startsWith("\r\n", end)) end += 2;
  else if (raw.startsWith("\n", end)) end += 1;
  else return range;
  return { start: range.start, end };
}

function normalizeBodyLines(body: string): string[] {
  const lines = body.replace(/\r\n/g, "\n").split("\n");
  while (lines.length > 0 && lines[0]?.trim() === "") lines.shift();
  while (lines.length > 0 && lines[lines.length - 1]?.trim() === "") lines.pop();
  if (lines.length === 0) return fail("invalid-body", "comment text is empty");
  for (const line of lines) {
    if (line.startsWith("<!-- task-")) {
      return fail(
        "invalid-body",
        "comment text may not contain a task-* sentinel line at column 0",
      );
    }
  }
  return lines;
}

function displayName(author: string, authorDisplay: string | undefined): string {
  const cleaned = authorDisplay?.replace(/\s+/g, " ").trim() ?? "";
  return cleaned === "" ? author : cleaned;
}

function allIds(doc: StructuredDocument): Set<string> {
  const ids = new Set<string>();
  for (const thread of doc.discussion?.threads ?? []) {
    ids.add(thread.id);
    for (const comment of thread.comments) ids.add(comment.id);
  }
  return ids;
}

function requireThread(doc: StructuredDocument, threadId: string): Thread {
  const thread = doc.discussion?.threads.find((t) => t.id === threadId);
  return thread ?? fail("unknown-thread", `no thread with id ${threadId}`);
}

function requireComment(
  doc: StructuredDocument,
  commentId: string,
): { thread: Thread; comment: ThreadComment } {
  for (const thread of doc.discussion?.threads ?? []) {
    const comment = thread.comments.find((c) => c.id === commentId);
    if (comment !== undefined) return { thread, comment };
  }
  return fail("unknown-comment", `no comment with id ${commentId}`);
}

interface NewCommentInput {
  body: string;
  author: string;
  authorDisplay?: string;
  createdAt: string;
  commentId?: string;
}

function validateNewComment(
  doc: StructuredDocument,
  input: NewCommentInput,
): { id: string; bodyLines: string[] } {
  if (!isValidAuthor(input.author)) {
    return fail("invalid-author", "author must be a single token without whitespace or `--`");
  }
  if (!isValidCreatedAt(input.createdAt)) {
    return fail(
      "invalid-created",
      "createdAt must be an ISO-8601 UTC instant like 2026-07-28T08:30:00Z",
    );
  }
  const id = input.commentId ?? newCommentId();
  if (!isValidId(id)) return fail("invalid-id", `invalid comment id ${id}`);
  if (allIds(doc).has(id)) return fail("duplicate-id", `id ${id} already exists in this document`);
  return { id, bodyLines: normalizeBodyLines(input.body) };
}

function commentBlockLines(input: {
  id: string;
  author: string;
  authorDisplay?: string;
  createdAt: string;
  inReplyTo?: string;
  bodyLines: string[];
}): string[] {
  return [
    formatCommentBegin({
      id: input.id,
      author: input.author,
      createdAt: input.createdAt,
      inReplyTo: input.inReplyTo ?? null,
    }),
    `#### ${displayName(input.author, input.authorDisplay)} · ${formatUtcTimestamp(input.createdAt)}`,
    "",
    ...input.bodyLines,
    formatCommentEnd(input.id),
  ];
}

function nextThreadLabel(doc: StructuredDocument): string {
  let max = 0;
  for (const thread of doc.discussion?.threads ?? []) {
    const match = thread.label === null ? null : /^T(\d+)$/.exec(thread.label);
    if (match?.[1] !== undefined) max = Math.max(max, Number(match[1]));
  }
  return `T${max + 1}`;
}

export interface AddThreadOptions extends NewCommentInput {
  /** Anchor the thread to body text; omitted for a plain task-level comment. */
  anchor?: AnchorSelector;
  /** Insert a `[T1](#thread-…)` link after the anchored text. Default: anchored. */
  insertMarker?: boolean;
  threadId?: string;
  label?: string;
}

export interface AddThreadResult extends EditResult {
  threadId: string;
  commentId: string;
  label: string;
}

export function addThread(doc: StructuredDocument, options: AddThreadOptions): AddThreadResult {
  const { id: commentId, bodyLines } = validateNewComment(doc, options);
  const threadId = options.threadId ?? newThreadId();
  if (!isValidId(threadId)) return fail("invalid-id", `invalid thread id ${threadId}`);
  if (allIds(doc).has(threadId) || threadId === commentId) {
    return fail("duplicate-id", `id ${threadId} already exists in this document`);
  }
  const label = options.label ?? nextThreadLabel(doc);
  if (!/^\S[^\n·]{0,59}$/.test(label)) {
    return fail("invalid-label", "label must be a short single-line string without `·`");
  }
  let anchor: AnchorSelector | undefined;
  if (options.anchor !== undefined) {
    const validated = validateAnchorSelector(options.anchor);
    if (validated === null) return fail("invalid-anchor", "anchor selector has an invalid shape");
    anchor = validated;
  }

  const eol = dominantEol(doc.raw);
  const blockLines = [
    formatThreadBegin(threadId, "open"),
    `<a id="thread-${threadId}"></a>`,
    `### ${label} · Open`,
    "",
    ...(anchor !== undefined ? [formatAnchorSentinel(anchor), ""] : []),
    ...commentBlockLines({ id: commentId, ...options, bodyLines }),
    "",
    formatThreadEnd(threadId),
  ];

  const splices: Splice[] = [];
  const insertAt = doc.raw.length;
  const storePreamble =
    doc.discussion === null ? [formatStoreSentinel(), "", "## Discussion", ""] : [];
  splices.push({
    range: { start: insertAt, end: insertAt },
    insert:
      blockPadding(doc.raw, insertAt, eol) + [...storePreamble, ...blockLines].join(eol) + eol,
  });

  if (anchor !== undefined && options.insertMarker !== false) {
    const resolved = resolveThreadAnchor(doc.body, threadId, anchor);
    if (resolved.state === "attached" && resolved.range !== null) {
      const at = doc.bodyRange.start + resolved.range.end;
      const before = doc.raw[at - 1];
      const space = before !== undefined && /\s/.test(before) ? "" : " ";
      splices.push({
        range: { start: at, end: at },
        insert: `${space}[${label}](#thread-${threadId})`,
      });
    }
  }
  const result = finish(doc, splices);
  return { ...result, threadId, commentId, label };
}

export interface AddCommentOptions extends NewCommentInput {
  threadId: string;
  inReplyTo?: string;
}

export interface AddCommentResult extends EditResult {
  commentId: string;
}

export function addComment(doc: StructuredDocument, options: AddCommentOptions): AddCommentResult {
  const thread = requireThread(doc, options.threadId);
  const { id: commentId, bodyLines } = validateNewComment(doc, options);
  if (options.inReplyTo !== undefined && !thread.comments.some((c) => c.id === options.inReplyTo)) {
    return fail("invalid-reply-target", `thread ${thread.id} has no comment ${options.inReplyTo}`);
  }
  const eol = dominantEol(doc.raw);
  const endLineStart = startOfLastLine(doc.raw, thread.range);
  const block = commentBlockLines({ id: commentId, ...options, bodyLines });
  const insert = blockPadding(doc.raw, endLineStart, eol) + block.join(eol) + eol + eol;
  const result = finish(doc, [{ range: { start: endLineStart, end: endLineStart }, insert }]);
  return { ...result, commentId };
}

export function setThreadStatus(
  doc: StructuredDocument,
  threadId: string,
  status: "open" | "resolved",
): EditResult {
  const thread = requireThread(doc, threadId);
  if (thread.status === status) return { doc, raw: doc.raw, splices: [] };
  const splices: Splice[] = [];

  const beginLine = lineAt(doc.raw, thread.range.start);
  const parsed = parseSentinelLine(beginLine.content, thread.range.start);
  if (!parsed.ok || parsed.token.kind !== "thread-begin") {
    throw new Error("unreachable: structured thread has an unparsable begin sentinel");
  }
  splices.push({ range: parsed.token.statusValueRange, insert: status });

  // Keep a `### T1 · Open` presentation heading in sync when one exists.
  const firstComment = thread.comments[0];
  const preambleEnd =
    firstComment !== undefined ? firstComment.range.start : startOfLastLine(doc.raw, thread.range);
  let cursor = beginLine.end;
  while (cursor < preambleEnd) {
    const line = lineAt(doc.raw, cursor);
    const match = /^### (?:.+?) · (Open|Resolved)$/.exec(line.content);
    if (match !== null) {
      const word = status === "open" ? "Open" : "Resolved";
      const wordStart = cursor + line.content.length - (match[1]?.length ?? 0);
      splices.push({
        range: { start: wordStart, end: cursor + line.content.length },
        insert: word,
      });
      break;
    }
    if (line.end <= cursor) break;
    cursor = line.end;
  }
  return finish(doc, splices);
}

export function editComment(doc: StructuredDocument, commentId: string, body: string): EditResult {
  const { comment } = requireComment(doc, commentId);
  if (comment.deleted) return fail("comment-deleted", `comment ${commentId} is deleted`);
  const eol = dominantEol(doc.raw);
  const bodyLines = normalizeBodyLines(body);
  const insert =
    comment.bodyRange.start === comment.bodyRange.end
      ? bodyLines.join(eol) + eol
      : bodyLines.join(eol);
  return finish(doc, [{ range: comment.bodyRange, insert }]);
}

export function deleteComment(doc: StructuredDocument, commentId: string): EditResult {
  const { thread, comment } = requireComment(doc, commentId);
  if (comment.deleted) return fail("comment-deleted", `comment ${commentId} is already deleted`);
  const hasReplies = thread.comments.some((c) => c.inReplyTo === commentId);

  if (!hasReplies) {
    // Deleting the last non-deleted comment clears the whole thread — a
    // thread holding only tombstones has no live content left, and leaving
    // it would strand tombstones nothing can ever delete.
    const liveAfter = thread.comments.filter((c) => !c.deleted && c.id !== commentId).length;
    if (liveAfter === 0) return removeThread(doc, thread.id);
    return finish(doc, [{ range: withTrailingBlankLine(doc.raw, comment.range), insert: "" }]);
  }

  // Replies still reference this comment: keep identity, clear content.
  const eol = dominantEol(doc.raw);
  const beginLine = lineAt(doc.raw, comment.range.start);
  const parsed = parseSentinelLine(beginLine.content, comment.range.start);
  if (!parsed.ok || parsed.token.kind !== "comment-begin") {
    throw new Error("unreachable: structured comment has an unparsable begin sentinel");
  }
  const tombstone = "*Deleted.*";
  const bodyInsert =
    comment.bodyRange.start === comment.bodyRange.end ? tombstone + eol : tombstone;
  return finish(doc, [
    {
      range: { start: parsed.token.attrsEnd, end: parsed.token.attrsEnd },
      insert: " deleted=true",
    },
    { range: comment.bodyRange, insert: bodyInsert },
  ]);
}

export function removeThread(doc: StructuredDocument, threadId: string): EditResult {
  const thread = requireThread(doc, threadId);
  const discussion = doc.discussion;
  if (discussion === null) throw new Error("unreachable: thread without a discussion store");
  const splices: Splice[] = [{ range: withTrailingBlankLine(doc.raw, thread.range), insert: "" }];

  // Drop inline markers pointing at the removed thread, with one preceding
  // space when the marker was inserted space-separated.
  const escapedId = threadId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const markerPattern = new RegExp(`\\[[^\\]\\n]*\\]\\(#thread-${escapedId}\\)`, "g");
  for (const match of doc.body.matchAll(markerPattern)) {
    const index = match.index;
    if (index === undefined) continue;
    let start = doc.bodyRange.start + index;
    if (doc.raw[start - 1] === " ") start--;
    splices.push({
      range: { start, end: doc.bodyRange.start + index + match[0].length },
      insert: "",
    });
  }

  // If this was the last thread and the store holds nothing but its heading
  // scaffolding, remove the whole store section.
  if (discussion.threads.length === 1) {
    const removed = withTrailingBlankLine(doc.raw, thread.range);
    const remainder =
      doc.raw.slice(discussion.range.start, removed.start) +
      doc.raw.slice(removed.end, discussion.range.end);
    const remainderLines = remainder
      .split("\n")
      .map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));
    const scaffoldingOnly = remainderLines.every(
      (line, index) =>
        index === 0 || // the store sentinel line itself
        line.trim() === "" ||
        /^#{1,6} /.test(line) ||
        /^<a id="[^"]*"><\/a>$/.test(line),
    );
    if (scaffoldingOnly) {
      let start = discussion.range.start;
      if (doc.raw.endsWith("\r\n", start)) start -= 2;
      else if (doc.raw.endsWith("\n", start)) start -= 1;
      return finish(doc, [
        { range: { start, end: discussion.range.end }, insert: "" },
        ...splices.slice(1),
      ]);
    }
  }
  return finish(doc, splices);
}

export function setThreadAnchor(
  doc: StructuredDocument,
  threadId: string,
  selector: AnchorSelector | null,
): EditResult {
  const thread = requireThread(doc, threadId);
  const eol = dominantEol(doc.raw);
  if (selector !== null) {
    const validated = validateAnchorSelector(selector);
    if (validated === null) return fail("invalid-anchor", "anchor selector has an invalid shape");
    const line = formatAnchorSentinel(validated);
    if (thread.anchor !== null) {
      return finish(doc, [{ range: thread.anchor.range, insert: line + eol }]);
    }
    const firstComment = thread.comments[0];
    const at =
      firstComment !== undefined
        ? firstComment.range.start
        : startOfLastLine(doc.raw, thread.range);
    return finish(doc, [
      { range: { start: at, end: at }, insert: blockPadding(doc.raw, at, eol) + line + eol + eol },
    ]);
  }
  if (thread.anchor === null) return { doc, raw: doc.raw, splices: [] };
  return finish(doc, [{ range: withTrailingBlankLine(doc.raw, thread.anchor.range), insert: "" }]);
}

function lineAt(raw: string, start: number): { content: string; end: number } {
  const nl = raw.indexOf("\n", start);
  if (nl === -1) return { content: raw.slice(start), end: raw.length };
  const contentEnd = nl > start && raw[nl - 1] === "\r" ? nl - 1 : nl;
  return { content: raw.slice(start, contentEnd), end: nl + 1 };
}
