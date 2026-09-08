import { useMemo, useState } from "react";
import { MessageResponse } from "@iterate-com/ui/components/ai-elements/message";
import type {
  DocumentCommentsProps,
  ReviewAction,
  ReviewThread,
} from "@iterate-com/ui/components/document-comments";
import type { DocumentPreviewProps } from "@iterate-com/ui/components/document-preview";
import { toast } from "@iterate-com/ui/components/sonner";
import {
  applyReviewOperation,
  readReview,
  sourceRangeForDisplayRange,
  type ReviewOperation,
} from "iterate/document-review";
import { authorColor } from "./collab-author.ts";
import type { CommentIdentity } from "./types.ts";

/** Connect RFM source to the format-independent preview and comments UI. */
export function useDocumentReview({
  source,
  identity,
  busy,
  onTransform,
}: {
  source: string;
  identity: CommentIdentity | null;
  busy: boolean;
  /** Apply to the current local source; false means the editor is unavailable. */
  onTransform: (transform: (current: string) => string) => boolean;
}) {
  const review = useMemo(() => readReview(source), [source]);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const canWrite =
    identity !== null && !busy && !review.diagnostics.some((d) => d.severity === "error");

  const apply = (operation: ReviewOperation) => {
    try {
      const applied = onTransform((current) => {
        const result = applyReviewOperation(current, operation);
        if (!result.ok) throw new Error(result.message);
        return result.source;
      });
      if (!applied) {
        toast.error(
          "The document editor is unavailable. Your draft is saved here; reconnect to continue.",
        );
      }
      return applied;
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
      return false;
    }
  };

  const onAction = (action: ReviewAction) => {
    if (!identity) return false;
    switch (action.kind) {
      case "add-document-comment":
        return apply({ type: action.kind, body: action.body, author: identity.author });
      case "reply":
        return apply({
          type: "reply",
          parentId: action.threadId,
          body: action.body,
          author: identity.author,
        });
      case "edit-comment":
        return apply({ type: "edit", id: action.commentId, body: action.body });
      case "delete-comment":
        return apply({ type: "delete", id: action.commentId });
      case "set-thread-status":
        return apply({ type: "set-status", id: action.threadId, status: action.status });
      case "accept-suggestion":
      case "reject-suggestion":
        return apply({ type: action.kind, id: action.threadId });
    }
  };

  const threads: ReviewThread[] = review.threads.map((thread) => ({
    id: thread.id,
    status: thread.comments[0]?.status ?? "open",
    quote: thread.anchor
      ? review.projection.markdown.slice(thread.anchor.display.start, thread.anchor.display.end)
      : null,
    comments: thread.comments.map((comment) => ({
      id: comment.id,
      author:
        comment.author === identity?.author
          ? (identity.authorDisplay ?? identity.author)
          : comment.author,
      color: authorColor(comment.author ?? "someone", 1),
      createdAt: comment.createdAt,
      body: comment.body,
      canEdit: canWrite && comment.author === identity?.author,
      canDelete: canWrite && comment.author === identity?.author,
    })),
  }));
  for (const suggestion of review.suggestions) {
    const thread = threads.find((thread) => thread.id === suggestion.id);
    const value: ReviewThread = {
      id: suggestion.id,
      status: suggestion.status,
      quote: suggestion.originalText || suggestion.replacementText,
      comments: thread?.comments ?? [],
      suggestion: {
        kind: suggestion.kind,
        author: suggestion.author,
        createdAt: suggestion.createdAt,
        originalText: suggestion.originalText,
        replacementText: suggestion.replacementText,
      },
    };
    if (thread) Object.assign(thread, value);
    else threads.push(value);
  }

  const comments: DocumentCommentsProps = {
    threads,
    notice: review.diagnostics.some((diagnostic) => diagnostic.severity === "error") ? (
      <p role="alert" className="p-3 text-sm text-destructive">
        {review.diagnostics
          .filter((diagnostic) => diagnostic.severity === "error")
          .map((diagnostic) => diagnostic.message)
          .join(" ")}{" "}
        Open Source to repair the review markup.
      </p>
    ) : busy ? (
      <p role="status" className="p-3 text-sm text-muted-foreground">
        Connecting to the document…
      </p>
    ) : undefined,
    selectedThreadId: selectedIds[0] ?? null,
    onSelectThread: (id) => setSelectedIds(id ? [id] : []),
    onAction: canWrite ? onAction : undefined,
    renderComment: (body) => (
      <MessageResponse loadingFallback={null} parseIncompleteMarkdown={false}>
        {body}
      </MessageResponse>
    ),
  };
  const preview: DocumentPreviewProps = {
    markdown: review.projection.markdown,
    annotations: [
      ...review.threads.flatMap((thread) =>
        thread.anchor
          ? [
              {
                id: thread.id,
                ...thread.anchor.display,
                state: thread.comments[0]?.status,
                color: authorColor(thread.comments[0]?.author ?? "someone", 1),
              },
            ]
          : [],
      ),
      ...review.suggestions.map((suggestion) => ({
        id: suggestion.id,
        ...suggestion.display,
        state: suggestion.status,
        tone: suggestion.kind,
      })),
    ],
    selectedAnnotationIds: selectedIds,
    onSelectAnnotations: setSelectedIds,
    onComment: canWrite
      ? (range, body) => {
          if (range.markdown !== review.projection.markdown) {
            toast.error(
              "The document changed after you selected this text. Select the passage again.",
            );
            return false;
          }
          const sourceRange = sourceRangeForDisplayRange(review.projection, range);
          if (!sourceRange || !identity) {
            toast.error("This selection cannot be attached to the Markdown source.");
            return false;
          }
          return apply({
            type: "add-selected-comment",
            expectedSource: source,
            range: sourceRange,
            body,
            author: identity.author,
          });
        }
      : undefined,
  };
  return { preview, comments };
}
