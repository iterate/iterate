import {
  appendRoughdraftDocumentComment,
  appendRoughdraftReply,
  extractRoughdraftReviewIndex,
  markRoughdraftResolved,
  validateRoughdraftMarkdown,
} from "roughdraft/packages/rfm/dist/index.js";
import type { RfmReviewItem } from "roughdraft/packages/rfm/dist/index.js";
import { isMap, parseDocument } from "yaml";
import type { Document, YAMLMap } from "yaml";
import type {
  ApplyReviewOperationResult,
  DocumentReview,
  ReviewAnchor,
  ReviewComment,
  ReviewDiagnostic,
  ReviewOperation,
  ReviewProjection,
  ReviewProjectionSegment,
  ReviewRange,
  ReviewSuggestion,
  ReviewThread,
} from "./types.ts";

export type {
  ApplyReviewOperationResult,
  DocumentReview,
  ReviewAnchor,
  ReviewComment,
  ReviewDiagnostic,
  ReviewOperation,
  ReviewProjection,
  ReviewProjectionSegment,
  ReviewRange,
  ReviewSuggestion,
  ReviewThread,
} from "./types.ts";

interface IndexedReview {
  bodyRange: ReviewRange;
  items: RfmReviewItem[];
  diagnostics: ReviewDiagnostic[];
}

const criticMarkupClose = /<<}|\+\+}|--}|~~}|==}/;
const inlineCommentPlaceholder = "iterate-rfm-inline-comment-placeholder";

export function readReview(source: string): DocumentReview {
  const indexed = indexReview(source);
  const anchors = anchorsFor(indexed, source);
  const projection = projectReviewBody(source, indexed, anchors);
  const threads = threadsFor(indexed, anchors, projection);
  const suggestions = suggestionsFor(indexed, projection);

  return {
    body: {
      source: source.slice(indexed.bodyRange.start, indexed.bodyRange.end),
      range: indexed.bodyRange,
    },
    threads,
    suggestions,
    diagnostics: indexed.diagnostics,
    projection,
  };
}

export function applyReviewOperation(
  source: string,
  operation: ReviewOperation,
): ApplyReviewOperationResult {
  const review = readReview(source);
  if (review.diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
    return failure(
      "invalid-document",
      "Review markup must be valid before it can be changed.",
      review,
    );
  }

  try {
    let nextSource: string;
    let selectedCommentId: string | null = null;
    if (operation.type === "add-document-comment") {
      nextSource = appendRoughdraftDocumentComment(source, {
        id: newReviewId("c"),
        message: operation.body,
        author: operation.author,
        at: operation.createdAt,
      });
    } else if (operation.type === "add-selected-comment") {
      if (operation.expectedSource !== source) {
        return failure(
          "stale-selection",
          "The document changed after this selection was made. Select the text again.",
          review,
        );
      }
      if (!containsRange(review.body.source, operation.range)) {
        return failure(
          "invalid-operation",
          "The selected range is outside the document body.",
          review,
        );
      }
      if (operation.range.start === operation.range.end) {
        return failure("invalid-operation", "Select text before adding a passage comment.", review);
      }
      const indexedItems = extractRoughdraftReviewIndex(source).items;
      if (
        review.threads.some(
          (thread) =>
            thread.anchor !== null && rangesOverlap(thread.anchor.source, operation.range),
        ) ||
        indexedItems.some(
          (item) =>
            item.offset >= review.body.range.start &&
            item.endOffset <= review.body.range.end &&
            rangesOverlap(
              {
                start: item.offset - review.body.range.start,
                end: item.endOffset - review.body.range.start,
              },
              operation.range,
            ),
        )
      ) {
        return failure(
          "overlapping-selection",
          "Roughdraft comments cannot cross an existing review annotation. Select a separate passage.",
          review,
        );
      }
      if (criticMarkupClose.test(operation.body)) {
        return failure(
          "invalid-operation",
          "Comment text contains a CriticMarkup closing delimiter.",
          review,
        );
      }
      const id = newReviewId("c");
      selectedCommentId = id;
      const start = review.body.range.start + operation.range.start;
      const end = review.body.range.start + operation.range.end;
      const selected = source.slice(start, end);
      nextSource = appendRoughdraftDocumentComment(source, {
        id,
        message: inlineCommentPlaceholder,
        author: operation.author,
        at: operation.createdAt,
      });
      const endmatter = reviewEndmatter(nextSource, review.body.range.start);
      if (!endmatter) throw new Error("Roughdraft did not create comment metadata.");
      // Add metadata before introducing a reference after a thematic break;
      // preserve the original body, including selected trailing whitespace.
      nextSource = `${source.slice(0, start)}{==${selected}==}{>>${operation.body}<<}{#${id}}${source.slice(end, review.body.range.end)}${nextSource.slice(endmatter.start)}`;
      nextSource = removeEndmatterField(nextSource, id, "body");
    } else if (operation.type === "reply") {
      if (!findItem(source, operation.parentId))
        return failure("missing-item", "Reply target was not found.", review);
      const id = newReviewId("c");
      const reply = {
        id,
        message: operation.body,
        author: operation.author,
        at: operation.createdAt,
      };
      nextSource = hasEndmatterEntry(source, operation.parentId)
        ? updateEndmatterField(
            appendRoughdraftDocumentComment(source, reply),
            id,
            "re",
            operation.parentId,
          )
        : appendRoughdraftReply(source, { ...reply, parentId: operation.parentId });
    } else if (operation.type === "set-status") {
      const item = findItem(source, operation.id);
      if (item === null) return failure("missing-item", "Review item was not found.", review);
      if (operation.status === "resolved") {
        nextSource = markRoughdraftResolved(source, {
          targetId: operation.id,
          summary: operation.summary,
        });
      } else if (hasEndmatterEntry(source, item.id)) {
        nextSource = updateEndmatterField(source, item.id, "status", "open");
        nextSource = removeEndmatterField(nextSource, item.id, "resolved");
      } else {
        nextSource = reopenInlineItem(source, item);
      }
    } else if (operation.type === "edit") {
      const item = findItem(source, operation.id);
      if (item === null || item.kind === "suggestion") {
        return failure("missing-item", "Comment was not found.", review);
      }
      if (criticMarkupClose.test(operation.body)) {
        return failure(
          "invalid-operation",
          "Comment text contains a CriticMarkup closing delimiter.",
          review,
        );
      }
      const close = source.indexOf("<<}", item.offset + 3);
      if (item.offset < review.body.range.end && close !== -1 && close < item.endOffset) {
        nextSource = `${source.slice(0, item.offset + 3)}${operation.body}${source.slice(close)}`;
      } else {
        nextSource = updateEndmatterField(source, item.id, "body", operation.body);
      }
    } else if (operation.type === "delete") {
      const items = extractRoughdraftReviewIndex(source).items;
      const target = items.find((item) => item.id === operation.id);
      if (target === undefined || target.kind === "suggestion") {
        return failure("missing-item", "Comment was not found.", review);
      }
      const deletedIds = descendantsOf(items, operation.id);
      nextSource = applySourceSplices(
        source,
        removeReviewItemsFromBody(source, items, deletedIds, review.body.range.end),
      );
      for (const id of deletedIds) nextSource = removeEndmatterEntry(nextSource, id);
    } else {
      const items = extractRoughdraftReviewIndex(source).items;
      const suggestion = items.find(
        (item) => item.id === operation.id && item.kind === "suggestion",
      );
      if (suggestion === undefined)
        return failure("missing-item", "Suggestion was not found.", review);
      const replacement =
        operation.type === "accept-suggestion"
          ? suggestion.suggestionKind === "deletion"
            ? ""
            : (suggestion.replacementText ?? suggestion.text)
          : suggestion.suggestionKind === "addition"
            ? ""
            : (suggestion.originalText ?? suggestion.text);
      const deletedIds = descendantsOf(items, suggestion.id);
      deletedIds.delete(suggestion.id);
      nextSource = applySourceSplices(source, [
        {
          start: suggestion.offset,
          end: suggestion.endOffset,
          insert: replacement,
        },
        ...removeReviewItemsFromBody(source, items, deletedIds, review.body.range.end),
      ]);
      for (const commentId of deletedIds) nextSource = removeEndmatterEntry(nextSource, commentId);
      nextSource = removeEndmatterEntry(nextSource, suggestion.id, "suggestions");
    }

    const nextReview = readReview(nextSource);
    if (nextReview.diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
      return failure(
        "invalid-document",
        "The requested change would produce invalid review markup.",
        review,
      );
    }
    if (
      selectedCommentId !== null &&
      !nextReview.threads.some(
        (thread) =>
          thread.anchor !== null &&
          thread.comments.some((comment) => comment.id === selectedCommentId),
      )
    ) {
      return failure(
        "invalid-operation",
        "The selected passage cannot be represented as Roughdraft review markup.",
        review,
      );
    }
    if (
      operation.type === "set-status" &&
      reviewStatus(nextReview, operation.id) !== operation.status
    ) {
      return failure(
        "invalid-operation",
        "Roughdraft did not update this review item's status.",
        review,
      );
    }
    return { ok: true, source: nextSource, review: nextReview };
  } catch (error) {
    return failure(
      "invalid-operation",
      error instanceof Error ? error.message : "Review operation failed.",
      review,
    );
  }
}

export function sourceRangeForDisplayRange(
  projection: ReviewProjection,
  range: ReviewRange,
): ReviewRange | null {
  const start = sourceOffsetForDisplayOffset(projection, range.start, "start");
  const end = sourceOffsetForDisplayOffset(projection, range.end, "end");
  if (start === null || end === null || end <= start) return null;
  return { start, end };
}

function indexReview(source: string): IndexedReview {
  const bodyStart = frontmatterEnd(source);
  const validation = validateRoughdraftMarkdown(source);
  const index = extractRoughdraftReviewIndex(source);
  const endmatter = reviewEndmatter(source, bodyStart);
  const diagnostics: ReviewDiagnostic[] = validation.diagnostics.map((diagnostic) => ({
    code: diagnostic.code,
    message: diagnostic.message,
    severity: diagnostic.severity,
  }));
  const malformedEndmatter = malformedReservedEndmatter(source, bodyStart);
  if (malformedEndmatter !== null) {
    diagnostics.push({
      code: "invalid-endmatter-yaml",
      message: malformedEndmatter.message,
      severity: "error",
    });
  }
  const bodyEnd = endmatter?.start ?? malformedEndmatter?.start ?? source.length;
  return {
    bodyRange: { start: bodyStart, end: bodyEnd },
    items: index.items,
    diagnostics,
  };
}

function frontmatterEnd(source: string): number {
  const opening = /^(?:\uFEFF)?---[ \t]*\r?\n/.exec(source);
  if (opening === null) return 0;
  const closing = /^(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/m.exec(source.slice(opening[0].length));
  if (closing === null) return 0;
  const parsed = parseDocument(source.slice(opening[0].length, opening[0].length + closing.index));
  if (parsed.errors.length > 0 || !isMap(parsed.contents)) return 0;
  return opening[0].length + closing.index + closing[0].length;
}

interface ReviewEndmatter {
  start: number;
  document: Document;
  root: YAMLMap;
}

function reviewEndmatter(source: string, bodyStart: number): ReviewEndmatter | null {
  const start = finalEndmatterStart(source, bodyStart);
  if (start === null) return null;
  const document = parseDocument(source.slice(start).replace(/^\n---[ \t]*\r?\n/, ""));
  if (document.errors.length > 0 || !isMap(document.contents)) return null;
  const root = document.contents;
  if (!root.has("comments") && !root.has("suggestions")) return null;
  const comments = root.get("comments", true);
  const hasDocumentComment =
    isMap(comments) &&
    comments.items.some((pair) => {
      if (!isMap(pair.value)) return false;
      return (
        typeof pair.value.get("body") === "string" &&
        typeof pair.value.get("by") === "string" &&
        typeof pair.value.get("at") === "string" &&
        pair.value.get("re") === undefined
      );
    });
  const hasInlineReview = extractRoughdraftReviewIndex(source).items.some(
    (item) => item.offset < start,
  );
  if (!hasInlineReview && !hasDocumentComment) return null;
  return { start, document, root };
}

function malformedReservedEndmatter(
  source: string,
  bodyStart: number,
): { start: number; message: string } | null {
  const start = finalEndmatterStart(source, bodyStart);
  if (start === null) return null;
  const yaml = source.slice(start).replace(/^\n---[ \t]*\r?\n/, "");
  if (!/^(?:comments|suggestions):/m.test(yaml)) return null;
  const document = parseDocument(yaml);
  const firstError = document.errors[0];
  if (firstError === undefined) return null;
  return { start, message: firstError.message.split("\n")[0] ?? "Invalid review endmatter YAML." };
}

function finalEndmatterStart(source: string, bodyStart: number): number | null {
  const matches = [...source.matchAll(/\n---[ \t]*\r?\n/g)];
  const final = matches.at(-1);
  if (final?.index === undefined || final.index < bodyStart) return null;
  return final.index;
}

function anchorsFor(indexed: IndexedReview, source: string): Map<string, ReviewRange> {
  const anchors = new Map<string, ReviewRange>();
  for (const item of indexed.items) {
    const anchor = inlineAnchor(item, source);
    if (!anchor) continue;
    anchors.set(item.id, {
      start: anchor.open + 3 - indexed.bodyRange.start,
      end: anchor.open + 3 + anchor.text.length - indexed.bodyRange.start,
    });
  }
  return anchors;
}

function inlineAnchor(item: RfmReviewItem, source: string): { open: number; text: string } | null {
  if (item.anchorText === undefined) return null;
  const open = source.lastIndexOf(`{==${item.anchorText}==}`, item.offset);
  return open === -1 ? null : { open, text: item.anchorText };
}

function projectReviewBody(
  source: string,
  indexed: IndexedReview,
  anchors: Map<string, ReviewRange>,
): ReviewProjection {
  const body = source.slice(indexed.bodyRange.start, indexed.bodyRange.end);
  const hidden: ReviewRange[] = [];
  for (const item of indexed.items) {
    if (item.offset < indexed.bodyRange.start || item.offset >= indexed.bodyRange.end) continue;
    const anchor = anchors.get(item.id);
    if (anchor !== undefined) {
      const open = anchor.start - 3;
      hidden.push({ start: open, end: item.endOffset - indexed.bodyRange.start });
    } else {
      hidden.push({
        start: item.offset - indexed.bodyRange.start,
        end: item.endOffset - indexed.bodyRange.start,
      });
    }
  }
  hidden.sort((left, right) => left.start - right.start || right.end - left.end);

  const segments: ReviewProjectionSegment[] = [];
  let markdown = "";
  let sourceCursor = 0;
  for (const range of hidden) {
    if (range.end <= sourceCursor) continue;
    if (range.start > sourceCursor) {
      const text = body.slice(sourceCursor, range.start);
      const displayStart = markdown.length;
      markdown += text;
      segments.push({
        source: { start: sourceCursor, end: range.start },
        display: { start: displayStart, end: markdown.length },
      });
    }
    const anchoredItem = indexed.items.find(
      (item) =>
        anchors.get(item.id)?.start === range.start + 3 && item.offset >= indexed.bodyRange.start,
    );
    if (anchoredItem !== undefined) {
      const anchor = anchors.get(anchoredItem.id);
      if (anchor !== undefined) {
        const text = body.slice(anchor.start, anchor.end);
        const displayStart = markdown.length;
        markdown += text;
        segments.push({ source: anchor, display: { start: displayStart, end: markdown.length } });
      }
    } else {
      const suggestion = indexed.items.find(
        (item) =>
          item.kind === "suggestion" && item.offset - indexed.bodyRange.start === range.start,
      );
      if (suggestion !== undefined) {
        const text = displayTextForSuggestion(suggestion);
        const displayStart = markdown.length;
        markdown += text;
        segments.push({
          source: range,
          display: { start: displayStart, end: markdown.length },
          atomic: true,
        });
      }
    }
    sourceCursor = Math.max(sourceCursor, range.end);
  }
  if (sourceCursor < body.length) {
    const displayStart = markdown.length;
    markdown += body.slice(sourceCursor);
    segments.push({
      source: { start: sourceCursor, end: body.length },
      display: { start: displayStart, end: markdown.length },
    });
  }
  return { markdown, segments };
}

function threadsFor(
  indexed: IndexedReview,
  anchors: Map<string, ReviewRange>,
  projection: ReviewProjection,
): ReviewThread[] {
  const comments = indexed.items.filter((item) => item.kind !== "suggestion");
  const items = new Map(indexed.items.map((item) => [item.id, item]));
  const threads = new Map<string, ReviewThread>();
  for (const item of comments) {
    let root = item;
    let rootId = item.id;
    const visited = new Set<string>();
    while (root.parentId !== null && !visited.has(root.id)) {
      visited.add(root.id);
      const parent = items.get(root.parentId);
      if (parent === undefined) break;
      if (parent.kind === "suggestion") {
        rootId = parent.id;
        break;
      }
      root = parent;
      rootId = root.id;
    }
    const rootAnchor = anchorFor(root.id, anchors, projection);
    const thread = threads.get(rootId) ?? { id: rootId, anchor: rootAnchor, comments: [] };
    thread.comments.push({
      id: item.id,
      parentId: item.parentId,
      author: item.author,
      createdAt: item.createdAt,
      status: item.status === "resolved" ? "resolved" : "open",
      body: item.text,
    });
    threads.set(rootId, thread);
  }
  for (const thread of threads.values()) {
    thread.comments.sort(
      (left, right) => itemDepth(items.get(left.id), items) - itemDepth(items.get(right.id), items),
    );
  }
  return [...threads.values()].sort((left, right) => {
    const leftStart = left.anchor?.source.start ?? Number.MAX_SAFE_INTEGER;
    const rightStart = right.anchor?.source.start ?? Number.MAX_SAFE_INTEGER;
    return leftStart - rightStart;
  });
}

function suggestionsFor(indexed: IndexedReview, projection: ReviewProjection): ReviewSuggestion[] {
  return indexed.items.flatMap((item) => {
    if (item.kind !== "suggestion" || item.suggestionKind === undefined) return [];
    const start = item.offset - indexed.bodyRange.start;
    const source = { start, end: item.endOffset - indexed.bodyRange.start };
    const display = projection.segments.find(
      (segment) =>
        segment.atomic &&
        segment.source.start === source.start &&
        segment.source.end === source.end,
    )?.display;
    return [
      {
        id: item.id,
        kind: item.suggestionKind,
        author: item.author,
        createdAt: item.createdAt,
        status: item.status === "resolved" ? "resolved" : "open",
        source,
        display: display ?? { start: 0, end: 0 },
        originalText: item.originalText ?? (item.suggestionKind === "deletion" ? item.text : ""),
        replacementText:
          item.replacementText ?? (item.suggestionKind === "addition" ? item.text : ""),
      },
    ];
  });
}

function displayTextForSuggestion(item: RfmReviewItem): string {
  if (item.suggestionKind === "substitution") {
    return `${item.originalText ?? ""} → ${item.replacementText ?? item.text}`;
  }
  return item.text;
}

function anchorFor(
  id: string,
  anchors: Map<string, ReviewRange>,
  projection: ReviewProjection,
): ReviewAnchor | null {
  const source = anchors.get(id);
  if (source === undefined) return null;
  const display = displayRangeForSourceRange(projection, source);
  if (display === null) return null;
  return { source, display };
}

function displayRangeForSourceRange(
  projection: ReviewProjection,
  range: ReviewRange,
): ReviewRange | null {
  const start = displayOffsetForSourceOffset(projection, range.start, "start");
  const end = displayOffsetForSourceOffset(projection, range.end, "end");
  if (start === null || end === null || end < start) return null;
  return { start, end };
}

function displayOffsetForSourceOffset(
  projection: ReviewProjection,
  offset: number,
  affinity: "start" | "end",
): number | null {
  for (const segment of projection.segments) {
    if (segment.atomic && offset > segment.source.start && offset < segment.source.end) return null;
    const isWithin =
      affinity === "start"
        ? offset >= segment.source.start && offset < segment.source.end
        : offset > segment.source.start && offset <= segment.source.end;
    if (!isWithin) continue;
    return (
      segment.display.start +
      Math.min(offset - segment.source.start, segment.display.end - segment.display.start)
    );
  }
  if (affinity === "start") {
    return (
      projection.segments.find((segment) => segment.source.start >= offset)?.display.start ?? null
    );
  }
  return (
    projection.segments.findLast((segment) => segment.source.end <= offset)?.display.end ?? null
  );
}

function sourceOffsetForDisplayOffset(
  projection: ReviewProjection,
  offset: number,
  affinity: "start" | "end",
): number | null {
  for (const segment of projection.segments) {
    if (segment.atomic && offset > segment.display.start && offset < segment.display.end)
      return null;
    const isWithin =
      affinity === "start"
        ? offset >= segment.display.start && offset < segment.display.end
        : offset > segment.display.start && offset <= segment.display.end;
    if (!isWithin) continue;
    return (
      segment.source.start +
      Math.min(offset - segment.display.start, segment.source.end - segment.source.start)
    );
  }
  if (affinity === "start") {
    return (
      projection.segments.find((segment) => segment.display.start >= offset)?.source.start ?? null
    );
  }
  return (
    projection.segments.findLast((segment) => segment.display.end <= offset)?.source.end ?? null
  );
}

function findItem(source: string, id: string): RfmReviewItem | null {
  return extractRoughdraftReviewIndex(source).items.find((item) => item.id === id) ?? null;
}

function itemDepth(item: RfmReviewItem | undefined, items: Map<string, RfmReviewItem>): number {
  if (item === undefined) return Number.MAX_SAFE_INTEGER;
  let depth = 0;
  let parentId = item.parentId;
  const visited = new Set<string>([item.id]);
  while (parentId !== null && !visited.has(parentId)) {
    visited.add(parentId);
    depth++;
    parentId = items.get(parentId)?.parentId ?? null;
  }
  return depth;
}

function descendantsOf(items: RfmReviewItem[], id: string): Set<string> {
  const ids = new Set([id]);
  let found = true;
  while (found) {
    found = false;
    for (const item of items) {
      if (item.parentId !== null && ids.has(item.parentId) && !ids.has(item.id)) {
        ids.add(item.id);
        found = true;
      }
    }
  }
  return ids;
}

interface SourceSplice {
  start: number;
  end: number;
  insert: string;
}

/** Removes review controls while retaining the selected Markdown text. */
function removeReviewItemsFromBody(
  source: string,
  items: RfmReviewItem[],
  removedIds: Set<string>,
  bodyEnd: number,
): SourceSplice[] {
  const removedItems = items.filter((item) => removedIds.has(item.id) && item.offset < bodyEnd);
  const splices: SourceSplice[] = [];
  const coveredIds = new Set<string>();
  const anchors = new Map<number, { open: number; text: string }>();

  for (const item of removedItems) {
    const anchor = inlineAnchor(item, source);
    if (anchor !== null) anchors.set(anchor.open, anchor);
  }
  for (const anchor of anchors.values()) {
    const attached = items.filter((item) => inlineAnchor(item, source)?.open === anchor.open);
    if (attached.some((item) => !removedIds.has(item.id))) continue;

    let end = Math.max(...attached.map((item) => item.endOffset));
    let found = true;
    while (found) {
      found = false;
      for (const item of removedItems) {
        if (item.offset !== end || item.endOffset <= end) continue;
        end = item.endOffset;
        found = true;
      }
    }
    for (const item of removedItems) {
      if (item.offset >= anchor.open && item.endOffset <= end) coveredIds.add(item.id);
    }
    splices.push({ start: anchor.open, end, insert: anchor.text });
  }
  for (const item of removedItems) {
    if (!coveredIds.has(item.id))
      splices.push({ start: item.offset, end: item.endOffset, insert: "" });
  }
  return splices;
}

function applySourceSplices(source: string, splices: SourceSplice[]): string {
  let next = source;
  for (const splice of splices.toSorted((left, right) => right.start - left.start)) {
    next = `${next.slice(0, splice.start)}${splice.insert}${next.slice(splice.end)}`;
  }
  return next;
}

function reviewStatus(review: DocumentReview, id: string): "open" | "resolved" | null {
  const suggestion = review.suggestions.find((item) => item.id === id);
  if (suggestion !== undefined) return suggestion.status;
  for (const thread of review.threads) {
    const comment = thread.comments.find((item) => item.id === id);
    if (comment !== undefined) return comment.status;
  }
  return null;
}

function updateEndmatterField(source: string, id: string, field: string, value: string): string {
  return rewriteEndmatter(source, (root) => {
    const entry = reviewEntry(root, id);
    if (entry === null) throw new Error(`Roughdraft metadata for ${id} was not found.`);
    entry.set(field, value);
  });
}

function removeEndmatterField(source: string, id: string, field: string): string {
  return rewriteEndmatter(source, (root) => {
    reviewEntry(root, id)?.delete(field);
  });
}

function removeEndmatterEntry(source: string, id: string, section = "comments"): string {
  if (!hasEndmatterEntry(source, id)) return source;
  return rewriteEndmatter(source, (root) => {
    const entries = root.get(section, true);
    if (!isMap(entries)) return;
    entries.delete(id);
    if (entries.items.length === 0) root.delete(section);
  });
}

function rewriteEndmatter(source: string, change: (root: YAMLMap) => void): string {
  const start = finalEndmatterStart(source, frontmatterEnd(source));
  if (start === null) throw new Error("Roughdraft endmatter was not found.");
  const document = parseDocument(source.slice(start).replace(/^\n---[ \t]*\r?\n/, ""));
  if (document.errors.length > 0 || !isMap(document.contents)) {
    throw new Error("Roughdraft endmatter was not found.");
  }
  const endmatter = { start, document, root: document.contents };
  change(endmatter.root);
  if (endmatter.root.items.length === 0) {
    return `${source.slice(0, endmatter.start).replace(/\s*$/, "\n")}`;
  }
  const body = source.slice(0, endmatter.start).replace(/\s*$/, "\n");
  return `${body}\n---\n${endmatter.document.toString()}`;
}

function reviewEntry(root: YAMLMap, id: string): YAMLMap | null {
  for (const section of ["comments", "suggestions"]) {
    const entries = root.get(section, true);
    if (!isMap(entries)) continue;
    const entry = entries.get(id, true);
    if (isMap(entry)) return entry;
  }
  return null;
}

function hasEndmatterEntry(source: string, id: string): boolean {
  // Cleanup still needs the entry after its last inline reference was removed.
  const start = finalEndmatterStart(source, frontmatterEnd(source));
  if (start === null) return false;
  const document = parseDocument(source.slice(start).replace(/^\n---[ \t]*\r?\n/, ""));
  return (
    document.errors.length === 0 &&
    isMap(document.contents) &&
    reviewEntry(document.contents, id) !== null
  );
}

function reopenInlineItem(source: string, item: RfmReviewItem): string {
  const start = source.lastIndexOf("{", item.endOffset - 1);
  const end = source.indexOf("}", start);
  if (start === -1 || end === -1 || end + 1 !== item.endOffset) {
    throw new Error(`Roughdraft metadata for ${item.id} was not found.`);
  }
  const metadata = source.slice(start, end + 1);
  if (!metadata.includes(`id="${item.id}"`)) {
    throw new Error(`Roughdraft metadata for ${item.id} was not found.`);
  }
  const withoutResolution = metadata
    .replace(/\s+status="(?:\\.|[^"\\])*"/, "")
    .replace(/\s+resolved="(?:\\.|[^"\\])*"/, "");
  const reopened = `${withoutResolution.slice(0, -1)} status="open"}`;
  return `${source.slice(0, start)}${reopened}${source.slice(end + 1)}`;
}

function newReviewId(prefix: "c" | "s"): string {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}

function containsRange(source: string, range: ReviewRange): boolean {
  return (
    Number.isInteger(range.start) &&
    Number.isInteger(range.end) &&
    range.start >= 0 &&
    range.end >= range.start &&
    range.end <= source.length
  );
}

function rangesOverlap(left: ReviewRange, right: ReviewRange): boolean {
  return left.start < right.end && right.start < left.end;
}

function failure(
  code: Extract<ApplyReviewOperationResult, { ok: false }>["code"],
  message: string,
  review: DocumentReview,
): ApplyReviewOperationResult {
  return { ok: false, code, message, review };
}
