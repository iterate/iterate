"use client";

import * as React from "react";
import {
  CheckIcon,
  EllipsisIcon,
  MessageSquareIcon,
  PencilIcon,
  Trash2Icon,
  Undo2Icon,
  XIcon,
} from "lucide-react";

import { Avatar, AvatarFallback, AvatarImage } from "@iterate-com/ui/components/avatar";
import { Button } from "@iterate-com/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@iterate-com/ui/components/dropdown-menu";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@iterate-com/ui/components/empty";
import { Field, FieldGroup } from "@iterate-com/ui/components/field";
import { Textarea } from "@iterate-com/ui/components/textarea";
import { cn } from "@iterate-com/ui/lib/utils";

export type ReviewComment = {
  id: string;
  author: string | null;
  avatarUrl?: string | null;
  /** Optional author color shared with the document highlights. */
  color?: string;
  createdAt: string | null;
  body: string;
  canEdit?: boolean;
  canDelete?: boolean;
};

export type ReviewSuggestion = {
  kind: "addition" | "deletion" | "substitution";
  author?: string | null;
  createdAt?: string | null;
  originalText?: string;
  replacementText?: string;
  canAccept?: boolean;
  canReject?: boolean;
};

export type ReviewThread = {
  id: string;
  kind: "comment" | "suggestion";
  status: "open" | "resolved";
  quote?: string | null;
  comments: ReviewComment[];
  suggestion?: ReviewSuggestion;
};

export type ReviewAction =
  | { kind: "add-document-comment"; body: string }
  | { kind: "reply"; threadId: string; body: string }
  | { kind: "edit-comment"; threadId: string; commentId: string; body: string }
  | { kind: "delete-comment"; threadId: string; commentId: string }
  | { kind: "set-thread-status"; threadId: string; status: "open" | "resolved" }
  | { kind: "accept-suggestion"; threadId: string }
  | { kind: "reject-suggestion"; threadId: string };

export type DocumentCommentsProps = {
  threads: ReviewThread[];
  renderComment: (body: string) => React.ReactNode;
  selectedThreadId?: string | null;
  onSelectThread?: (threadId: string | null) => void;
  onAction?: (action: ReviewAction) => boolean;
  notice?: React.ReactNode;
  ref?: React.Ref<DocumentCommentsHandle>;
  className?: string;
};

export type DocumentCommentsHandle = {
  focusDocumentComment: () => void;
};

/**
 * A format-independent Markdown review panel. The caller owns parsing,
 * authorization and durable writes; the panel only keeps short-lived drafts.
 */
export function DocumentComments({
  threads,
  renderComment,
  selectedThreadId = null,
  onSelectThread,
  onAction,
  notice,
  ref,
  className,
}: DocumentCommentsProps) {
  const [showResolved, setShowResolved] = React.useState(false);
  const documentComposerRef = React.useRef<HTMLTextAreaElement | null>(null);
  React.useImperativeHandle(ref, () => ({
    focusDocumentComment() {
      documentComposerRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
      documentComposerRef.current?.focus();
    },
  }));
  const openThreads = threads.filter((thread) => thread.status === "open");
  const resolvedThreads = threads.filter((thread) => thread.status === "resolved");
  const visibleThreads = showResolved ? resolvedThreads : openThreads;
  const documentThreads = visibleThreads.filter((thread) => thread.quote == null);
  const selectionThreads = visibleThreads.filter((thread) => thread.quote != null);

  return (
    <section
      className={cn("flex h-full min-h-0 flex-col", className)}
      aria-label="Document comments"
    >
      {notice ? <div className="shrink-0 px-3 pt-3">{notice}</div> : null}
      <div className="flex shrink-0 items-center justify-between gap-2 px-4 py-3 text-xs text-muted-foreground">
        <h2 className="font-medium">
          Comments {openThreads.length ? `(${openThreads.length})` : ""}
        </h2>
        {resolvedThreads.length > 0 || showResolved ? (
          <button
            type="button"
            className="underline-offset-2 hover:text-foreground hover:underline"
            aria-pressed={showResolved}
            onClick={() => setShowResolved((value) => !value)}
          >
            {showResolved ? "Show open" : `Show ${resolvedThreads.length} resolved`}
          </button>
        ) : null}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4">
        <ThreadList
          documentThreads={documentThreads}
          selectionThreads={selectionThreads}
          selectedThreadId={selectedThreadId}
          onSelectThread={onSelectThread}
          onAction={onAction}
          renderComment={renderComment}
        />
      </div>
      {onAction ? <DocumentComposer textareaRef={documentComposerRef} onAction={onAction} /> : null}
    </section>
  );
}

function ThreadList({
  documentThreads,
  selectionThreads,
  selectedThreadId,
  onSelectThread,
  onAction,
  renderComment,
}: {
  documentThreads: ReviewThread[];
  selectionThreads: ReviewThread[];
  selectedThreadId: string | null;
  onSelectThread?: (threadId: string | null) => void;
  onAction?: (action: ReviewAction) => boolean;
  renderComment: (body: string) => React.ReactNode;
}) {
  if (documentThreads.length === 0 && selectionThreads.length === 0) {
    return (
      <Empty className="min-h-44 border-0">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <MessageSquareIcon />
          </EmptyMedia>
          <EmptyTitle>No comments here</EmptyTitle>
          <EmptyDescription>
            Start a document discussion or select text in the preview.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <ThreadGroup
        label="Whole document"
        threads={documentThreads}
        selectedThreadId={selectedThreadId}
        onSelectThread={onSelectThread}
        onAction={onAction}
        renderComment={renderComment}
      />
      <ThreadGroup
        label="Selected text"
        threads={selectionThreads}
        selectedThreadId={selectedThreadId}
        onSelectThread={onSelectThread}
        onAction={onAction}
        renderComment={renderComment}
      />
    </div>
  );
}

function ThreadGroup({
  label,
  threads,
  selectedThreadId,
  onSelectThread,
  onAction,
  renderComment,
}: {
  label: string;
  threads: ReviewThread[];
  selectedThreadId: string | null;
  onSelectThread?: (threadId: string | null) => void;
  onAction?: (action: ReviewAction) => boolean;
  renderComment: (body: string) => React.ReactNode;
}) {
  if (threads.length === 0) return null;
  return (
    <div className="flex flex-col">
      <h3 className="-mx-2 border-b bg-muted/20 px-2 py-1.5 text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">
        {label}
      </h3>
      {threads.map((thread) => (
        <ReviewThreadCard
          key={thread.id}
          thread={thread}
          selected={thread.id === selectedThreadId}
          onSelectThread={onSelectThread}
          onAction={onAction}
          renderComment={renderComment}
        />
      ))}
    </div>
  );
}

export function ReviewThreadCard({
  thread,
  selected,
  onSelectThread,
  onAction,
  renderComment,
}: {
  thread: ReviewThread;
  selected: boolean;
  onSelectThread?: (threadId: string | null) => void;
  onAction?: (action: ReviewAction) => boolean;
  renderComment: (body: string) => React.ReactNode;
}) {
  const [replying, setReplying] = React.useState(false);
  const cardRef = React.useRef<HTMLElement | null>(null);
  const [actionFailed, setActionFailed] = React.useState(false);
  const isResolved = thread.status === "resolved";
  React.useEffect(() => {
    if (selected) cardRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [selected]);
  const act = (action: ReviewAction) => {
    if (!onAction) return;
    try {
      setActionFailed(!onAction(action));
    } catch {
      setActionFailed(true);
    }
  };
  return (
    <article
      ref={cardRef}
      className={cn(
        "-mx-2 border-b border-border/50 px-2 py-2 last:border-b-0",
        isResolved && "opacity-70",
        selected && "rounded-md ring-1 ring-primary/30",
      )}
    >
      <div className="flex flex-col gap-1.5">
        {thread.quote ? (
          <button
            type="button"
            style={{ borderColor: thread.comments[0]?.color }}
            className="border-l-2 border-primary/50 pl-2 text-left text-xs text-muted-foreground italic hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
            title={thread.quote}
            onClick={() => onSelectThread?.(thread.id)}
          >
            <span className="block truncate">{thread.quote}</span>
          </button>
        ) : null}
        {thread.suggestion ? <SuggestionSummary suggestion={thread.suggestion} /> : null}
        {actionFailed ? (
          <p role="status" className="text-sm text-destructive">
            Couldn’t save that change. Try again.
          </p>
        ) : null}
        <div className="flex flex-col gap-1">
          {thread.comments.map((comment) => (
            <ReviewCommentCard
              key={comment.id}
              threadId={thread.id}
              comment={comment}
              onAction={onAction}
              renderComment={renderComment}
            />
          ))}
        </div>
        {replying && onAction ? (
          <ReviewComposer
            placeholder="Reply…"
            submitLabel="Reply"
            onCancel={() => setReplying(false)}
            onSubmit={(body) => {
              const ok = onAction({ kind: "reply", threadId: thread.id, body });
              if (ok) setReplying(false);
              return ok;
            }}
          />
        ) : null}
      </div>
      {onAction ? (
        <div className="flex flex-wrap items-center gap-1 pt-0.5 pl-6 text-muted-foreground">
          {!isResolved && !replying ? (
            <Button variant="ghost" size="xs" onClick={() => setReplying(true)}>
              Reply
            </Button>
          ) : null}
          <Button
            variant="ghost"
            size="xs"
            onClick={() =>
              act({
                kind: "set-thread-status",
                threadId: thread.id,
                status: isResolved ? "open" : "resolved",
              })
            }
          >
            {isResolved ? (
              <Undo2Icon data-icon="inline-start" />
            ) : (
              <CheckIcon data-icon="inline-start" />
            )}
            {isResolved ? "Reopen" : "Resolve"}
          </Button>
          {!isResolved && thread.suggestion?.canAccept ? (
            <Button
              variant="ghost"
              size="xs"
              onClick={() => act({ kind: "accept-suggestion", threadId: thread.id })}
            >
              <CheckIcon data-icon="inline-start" /> Accept
            </Button>
          ) : null}
          {!isResolved && thread.suggestion?.canReject ? (
            <Button
              variant="ghost"
              size="xs"
              onClick={() => act({ kind: "reject-suggestion", threadId: thread.id })}
            >
              <XIcon data-icon="inline-start" /> Reject
            </Button>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}

function ReviewCommentCard({
  threadId,
  comment,
  onAction,
  renderComment,
}: {
  threadId: string;
  comment: ReviewComment;
  onAction?: (action: ReviewAction) => boolean;
  renderComment: (body: string) => React.ReactNode;
}) {
  const [editing, setEditing] = React.useState(false);
  const author = comment.author ?? "Unknown author";
  return (
    <div className="group/comment flex min-w-0 gap-2 py-1.5">
      <Avatar size="sm" className="mt-0.5">
        {comment.avatarUrl ? <AvatarImage src={comment.avatarUrl} alt="" /> : null}
        <AvatarFallback
          style={comment.color ? { backgroundColor: comment.color, color: "white" } : undefined}
        >
          {initials(author)}
        </AvatarFallback>
      </Avatar>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 text-xs">
          <span className="min-w-0 truncate font-medium" title={author}>
            {author}
          </span>
          {comment.createdAt ? (
            <time
              className="shrink-0 whitespace-nowrap text-muted-foreground"
              dateTime={comment.createdAt}
              title={comment.createdAt}
            >
              {relativeTime(comment.createdAt)}
            </time>
          ) : null}
          {onAction && (comment.canEdit || comment.canDelete) ? (
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button
                    className="ml-auto opacity-100 sm:opacity-0 sm:group-hover/comment:opacity-100 sm:group-focus-within/comment:opacity-100"
                    variant="ghost"
                    size="icon-xs"
                    aria-label="Comment actions"
                  >
                    <EllipsisIcon />
                  </Button>
                }
              />
              <DropdownMenuContent align="end">
                <DropdownMenuGroup>
                  {comment.canEdit ? (
                    <DropdownMenuItem onClick={() => setEditing(true)}>
                      <PencilIcon /> Edit
                    </DropdownMenuItem>
                  ) : null}
                  {comment.canDelete ? (
                    <DropdownMenuItem
                      variant="destructive"
                      onClick={() =>
                        void onAction({ kind: "delete-comment", threadId, commentId: comment.id })
                      }
                    >
                      <Trash2Icon /> Delete
                    </DropdownMenuItem>
                  ) : null}
                </DropdownMenuGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
        </div>
        {editing && onAction ? (
          <div className="mt-2">
            <ReviewComposer
              initialValue={comment.body}
              placeholder="Edit comment…"
              submitLabel="Save"
              onCancel={() => setEditing(false)}
              onSubmit={(body) => {
                const ok = onAction({
                  kind: "edit-comment",
                  threadId,
                  commentId: comment.id,
                  body,
                });
                if (ok) setEditing(false);
                return ok;
              }}
            />
          </div>
        ) : (
          <div className="text-sm">{renderComment(comment.body)}</div>
        )}
      </div>
    </div>
  );
}

function SuggestionSummary({ suggestion }: { suggestion: ReviewSuggestion }) {
  const label =
    suggestion.kind === "addition" ? "Add" : suggestion.kind === "deletion" ? "Delete" : "Replace";
  const text =
    suggestion.kind === "addition"
      ? suggestion.replacementText
      : suggestion.kind === "deletion"
        ? suggestion.originalText
        : suggestion.replacementText;
  return (
    <div className="rounded-lg bg-muted px-2.5 py-2 text-sm">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span className="font-medium text-foreground">{suggestion.author ?? "Unknown author"}</span>
        {suggestion.createdAt ? (
          <time dateTime={suggestion.createdAt} title={suggestion.createdAt}>
            {relativeTime(suggestion.createdAt)}
          </time>
        ) : null}
      </div>
      <p className="mt-1 text-xs font-medium text-muted-foreground">{label}</p>
      {suggestion.kind === "substitution" && suggestion.originalText ? (
        <del className="block text-muted-foreground">{suggestion.originalText}</del>
      ) : null}
      {text ? (
        <span className={cn("block", suggestion.kind === "addition" && "text-primary")}>
          {text}
        </span>
      ) : null}
    </div>
  );
}

function DocumentComposer({
  textareaRef,
  onAction,
}: {
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  onAction: (action: ReviewAction) => boolean;
}) {
  return (
    <div className="shrink-0 border-t bg-muted/20 px-4 py-3">
      <ReviewComposer
        textareaRef={textareaRef}
        placeholder="Comment on the entire document…"
        submitLabel="Add document comment"
        onSubmit={(body) => onAction({ kind: "add-document-comment", body })}
      />
    </div>
  );
}

export function ReviewComposer({
  initialValue = "",
  placeholder,
  submitLabel,
  textareaRef,
  onSubmit,
  onCancel,
}: {
  initialValue?: string;
  placeholder: string;
  submitLabel: string;
  textareaRef?: React.RefObject<HTMLTextAreaElement | null>;
  onSubmit: (body: string) => boolean;
  onCancel?: () => void;
}) {
  const [draft, setDraft] = React.useState(initialValue);
  const [error, setError] = React.useState<string | null>(null);
  const submit = () => {
    if (draft.trim() === "") return;
    setError(null);
    try {
      if (onSubmit(draft)) setDraft("");
    } catch (error) {
      setError(error instanceof Error ? error.message : "The comment could not be saved.");
    }
  };
  return (
    <div className="flex flex-col gap-2">
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <FieldGroup>
        <Field>
          <Textarea
            ref={textareaRef}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                submit();
              }
              if (event.key === "Escape" && onCancel) onCancel();
            }}
            placeholder={placeholder}
            rows={2}
            className="min-h-0 resize-none"
          />
        </Field>
      </FieldGroup>
      <div className="flex flex-wrap justify-end gap-2">
        {onCancel ? (
          <Button variant="ghost" size="xs" onClick={onCancel}>
            Cancel
          </Button>
        ) : null}
        <Button size="xs" disabled={draft.trim() === ""} onClick={submit}>
          {submitLabel}
        </Button>
      </div>
    </div>
  );
}

function initials(author: string) {
  return (
    author
      .split(/[\s._@-]+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0])
      .join("")
      .toUpperCase() || "?"
  );
}

function relativeTime(value: string) {
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) return value;
  const seconds = Math.round((Date.now() - timestamp) / 1_000);
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}
