"use client";

import * as React from "react";
import {
  CheckIcon,
  EllipsisIcon,
  FileTextIcon,
  MessageSquareIcon,
  PencilIcon,
  SendIcon,
  Trash2Icon,
  Undo2Icon,
  XIcon,
} from "lucide-react";

import { Avatar, AvatarFallback, AvatarImage } from "@iterate-com/ui/components/avatar";
import { Badge } from "@iterate-com/ui/components/badge";
import { Button } from "@iterate-com/ui/components/button";
import {
  Card,
  CardAction,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@iterate-com/ui/components/card";
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@iterate-com/ui/components/tabs";
import { Textarea } from "@iterate-com/ui/components/textarea";
import { cn } from "@iterate-com/ui/lib/utils";

export type ReviewComment = {
  id: string;
  author: string | null;
  avatarUrl?: string | null;
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
  onAction?: (action: ReviewAction) => Promise<boolean>;
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
  const [tab, setTab] = React.useState<"open" | "resolved">("open");
  const documentComposerRef = React.useRef<HTMLTextAreaElement | null>(null);
  React.useImperativeHandle(ref, () => ({
    focusDocumentComment() {
      documentComposerRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
      documentComposerRef.current?.focus();
    },
  }));
  const openThreads = threads.filter((thread) => thread.status === "open");
  const resolvedThreads = threads.filter((thread) => thread.status === "resolved");
  const visibleThreads = tab === "open" ? openThreads : resolvedThreads;
  const documentThreads = visibleThreads.filter((thread) => thread.quote == null);
  const selectionThreads = visibleThreads.filter((thread) => thread.quote != null);

  return (
    <section
      className={cn("flex h-full min-h-0 flex-col", className)}
      aria-label="Document comments"
    >
      {notice ? <div className="shrink-0 px-3 pt-3">{notice}</div> : null}
      <Tabs
        value={tab}
        onValueChange={(value) => {
          if (isReviewStatus(value)) setTab(value);
        }}
        className="min-h-0 flex-1"
      >
        <div className="flex shrink-0 items-center justify-between gap-2 border-b px-3 py-2">
          <TabsList aria-label="Comment status">
            <TabsTrigger value="open">Open {openThreads.length}</TabsTrigger>
            <TabsTrigger value="resolved">Resolved {resolvedThreads.length}</TabsTrigger>
          </TabsList>
          <span className="text-xs text-muted-foreground">{threads.length} total</span>
        </div>
        <TabsContent value={tab} className="min-h-0 overflow-y-auto px-3 py-3">
          <ThreadList
            documentThreads={documentThreads}
            selectionThreads={selectionThreads}
            selectedThreadId={selectedThreadId}
            onSelectThread={onSelectThread}
            onAction={onAction}
            renderComment={renderComment}
          />
        </TabsContent>
      </Tabs>
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
  onAction?: (action: ReviewAction) => Promise<boolean>;
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
    <div className="flex flex-col gap-4">
      <ThreadGroup
        label="Document"
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
  onAction?: (action: ReviewAction) => Promise<boolean>;
  renderComment: (body: string) => React.ReactNode;
}) {
  if (threads.length === 0) return null;
  return (
    <div className="flex flex-col gap-2">
      <h2 className="px-1 text-xs font-medium text-muted-foreground">{label}</h2>
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
  onAction?: (action: ReviewAction) => Promise<boolean>;
  renderComment: (body: string) => React.ReactNode;
}) {
  const [replying, setReplying] = React.useState(false);
  const cardRef = React.useRef<HTMLDivElement | null>(null);
  const [acting, setActing] = React.useState(false);
  const [actionFailed, setActionFailed] = React.useState(false);
  const isResolved = thread.status === "resolved";
  React.useEffect(() => {
    if (selected) cardRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [selected]);
  const act = (action: ReviewAction) => {
    if (!onAction || acting) return;
    setActing(true);
    setActionFailed(false);
    void onAction(action)
      .then((saved) => setActionFailed(!saved))
      .catch(() => setActionFailed(true))
      .finally(() => setActing(false));
  };
  return (
    <Card ref={cardRef} size="sm" className={cn(selected && "ring-2 ring-ring/30")}>
      <CardHeader>
        <CardTitle className="flex min-w-0 items-center gap-2">
          {thread.kind === "suggestion" ? <PencilIcon /> : <MessageSquareIcon />}
          <span className="truncate">
            {thread.kind === "suggestion" ? "Suggested change" : "Comment"}
          </span>
          {isResolved ? <Badge variant="secondary">Resolved</Badge> : null}
        </CardTitle>
        {thread.quote ? (
          <CardAction>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="Show selected text"
              onClick={() => onSelectThread?.(thread.id)}
            >
              <FileTextIcon />
            </Button>
          </CardAction>
        ) : null}
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {thread.quote ? (
          <button
            type="button"
            className="border-l-2 border-primary/50 pl-2 text-left text-xs text-muted-foreground italic hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
            title={thread.quote}
            onClick={() => onSelectThread?.(thread.id)}
          >
            <span className="block truncate">“{thread.quote}”</span>
          </button>
        ) : null}
        {thread.suggestion ? <SuggestionSummary suggestion={thread.suggestion} /> : null}
        {actionFailed ? (
          <p role="status" className="text-sm text-destructive">
            Couldn’t save that change. Try again.
          </p>
        ) : null}
        <div className="flex flex-col gap-3">
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
            onSubmit={(body) =>
              onAction({ kind: "reply", threadId: thread.id, body }).then((ok) => {
                if (ok) setReplying(false);
                return ok;
              })
            }
          />
        ) : null}
      </CardContent>
      {onAction ? (
        <CardFooter className="flex flex-wrap gap-1.5">
          {!isResolved && !replying ? (
            <Button variant="ghost" size="sm" onClick={() => setReplying(true)}>
              <MessageSquareIcon data-icon="inline-start" /> Reply
            </Button>
          ) : null}
          <Button
            variant="ghost"
            size="sm"
            disabled={acting}
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
              size="sm"
              disabled={acting}
              onClick={() => act({ kind: "accept-suggestion", threadId: thread.id })}
            >
              <CheckIcon data-icon="inline-start" /> Accept
            </Button>
          ) : null}
          {!isResolved && thread.suggestion?.canReject ? (
            <Button
              variant="ghost"
              size="sm"
              disabled={acting}
              onClick={() => act({ kind: "reject-suggestion", threadId: thread.id })}
            >
              <XIcon data-icon="inline-start" /> Reject
            </Button>
          ) : null}
        </CardFooter>
      ) : null}
    </Card>
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
  onAction?: (action: ReviewAction) => Promise<boolean>;
  renderComment: (body: string) => React.ReactNode;
}) {
  const [editing, setEditing] = React.useState(false);
  const author = comment.author ?? "Unknown author";
  return (
    <div className="flex min-w-0 gap-2">
      <Avatar size="sm">
        {comment.avatarUrl ? <AvatarImage src={comment.avatarUrl} alt="" /> : null}
        <AvatarFallback>{initials(author)}</AvatarFallback>
      </Avatar>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium">{author}</span>
          {comment.createdAt ? (
            <time
              className="text-xs text-muted-foreground"
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
                    className="ml-auto"
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
              onSubmit={(body) =>
                onAction({ kind: "edit-comment", threadId, commentId: comment.id, body }).then(
                  (ok) => {
                    if (ok) setEditing(false);
                    return ok;
                  },
                )
              }
            />
          </div>
        ) : (
          <div className="mt-1 text-sm">{renderComment(comment.body)}</div>
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
  onAction: (action: ReviewAction) => Promise<boolean>;
}) {
  return (
    <div className="shrink-0 border-t bg-muted/30 p-3">
      <div className="flex items-start gap-2">
        <MessageSquareIcon className="mt-1 size-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">Document comment</p>
          <p className="text-xs text-muted-foreground">Applies to the whole document.</p>
        </div>
      </div>
      <div className="mt-2">
        <ReviewComposer
          textareaRef={textareaRef}
          placeholder="Comment on the entire document…"
          submitLabel="Add document comment"
          onSubmit={(body) => onAction({ kind: "add-document-comment", body })}
        />
      </div>
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
  onSubmit: (body: string) => Promise<boolean>;
  onCancel?: () => void;
}) {
  const [draft, setDraft] = React.useState(initialValue);
  const [submitting, setSubmitting] = React.useState(false);
  const inFlight = React.useRef(false);
  const [error, setError] = React.useState<string | null>(null);
  const submit = () => {
    if (inFlight.current || draft.trim() === "") return;
    inFlight.current = true;
    setSubmitting(true);
    setError(null);
    void onSubmit(draft)
      .then((ok) => {
        if (ok) setDraft("");
      })
      .catch((error: unknown) =>
        setError(error instanceof Error ? error.message : "The comment could not be saved."),
      )
      .finally(() => {
        inFlight.current = false;
        setSubmitting(false);
      });
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
          <Button variant="ghost" size="sm" onClick={onCancel}>
            Cancel
          </Button>
        ) : null}
        <Button size="sm" disabled={submitting || draft.trim() === ""} onClick={submit}>
          <SendIcon data-icon="inline-start" /> {submitLabel}
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

function isReviewStatus(value: string): value is "open" | "resolved" {
  return value === "open" || value === "resolved";
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
