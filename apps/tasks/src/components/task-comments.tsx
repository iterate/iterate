import { useEffect, useMemo, useRef, useState } from "react";
import { CheckCircle2Icon, ChevronDownIcon, ChevronRightIcon, PencilIcon, Trash2Icon, Undo2Icon } from "lucide-react";
import { Button } from "@iterate-com/ui/components/button";
import { Textarea } from "@iterate-com/ui/components/textarea";
import { MessageResponse } from "@iterate-com/ui/components/ai-elements/message";
import { cn } from "@iterate-com/ui/lib/utils";
import {
  addComment,
  addThread,
  deleteComment,
  editComment,
  formatUtcTimestamp,
  parseAnnotatedMarkdown,
  setThreadStatus,
} from "iterate/annotated-markdown";
import type { StructuredDocument, Thread, ThreadComment } from "iterate/annotated-markdown";
import { authorColor } from "../lib/collab-redline.ts";

export type CommentIdentity = { author: string; authorDisplay?: string };

/** An edit against the parsed document; returns the next raw source. */
type DiscussionOp = (doc: StructuredDocument) => { raw: string };

/**
 * Linear-style discussion for one task file, backed by the annotated-markdown
 * codec: threads live at the end of the markdown file itself, so every
 * mutation here is an ordinary whole-file transform routed through the same
 * live-editor/write lane as any other task edit.
 */
export function TaskComments({
  source,
  identity,
  onTransform,
}: {
  source: string;
  identity: CommentIdentity | null;
  /** Route a whole-file transform to the live editor or the write lane. */
  onTransform: (transform: (source: string) => string) => void;
}) {
  const parsed = useMemo(() => parseAnnotatedMarkdown(source), [source]);
  const [open, setOpen] = useState(true);
  const [showResolved, setShowResolved] = useState(false);
  const [opError, setOpError] = useState<string | null>(null);

  // The transform re-parses at apply time: the live document may have moved
  // since this render, so ops must re-find their targets by id — and back off
  // to a no-op (surfacing the reason) instead of corrupting the file.
  const apply = (op: DiscussionOp): boolean => {
    let ok = false;
    let failure = "the file changed mid-edit";
    onTransform((current) => {
      const doc = parseAnnotatedMarkdown(current);
      if (doc.kind !== "structured") {
        failure = doc.diagnostics[0]?.message ?? "the file failed to parse";
        return current;
      }
      try {
        const result = op(doc);
        ok = true;
        return result.raw;
      } catch (error) {
        failure = error instanceof Error ? error.message : String(error);
        return current;
      }
    });
    setOpError(ok ? null : `Comment change failed: ${failure}`);
    return ok;
  };

  const threads = parsed.kind === "structured" ? (parsed.discussion?.threads ?? []) : [];
  const openThreads = threads.filter((thread) => thread.status === "open");
  const resolvedThreads = threads.filter((thread) => thread.status === "resolved");
  const commentTotal = threads.reduce(
    (total, thread) => total + thread.comments.filter((comment) => !comment.deleted).length,
    0,
  );

  return (
    <div className="flex min-h-0 flex-col">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex shrink-0 items-center gap-1.5 px-4 py-2 text-xs font-medium text-muted-foreground hover:text-foreground"
      >
        {open ? (
          <ChevronDownIcon aria-hidden className="size-3.5" />
        ) : (
          <ChevronRightIcon aria-hidden className="size-3.5" />
        )}
        Comments
        {commentTotal > 0 ? <span className="font-normal">({commentTotal})</span> : null}
      </button>
      {!open ? null : parsed.kind === "plain" ? (
        <p className="px-4 pb-3 text-xs text-muted-foreground">
          Comments are unavailable — {parsed.diagnostics[0]?.message ?? "the file failed to parse"}.
          Fix the file in the editor.
        </p>
      ) : (
        <>
          <div className="min-h-0 flex-1 overflow-y-auto px-4">
            {threads.length === 0 ? (
              <p className="pb-2 text-xs text-muted-foreground">No comments yet.</p>
            ) : null}
            {openThreads.map((thread) => (
              <ThreadBlock key={thread.id} thread={thread} identity={identity} apply={apply} />
            ))}
            {resolvedThreads.length > 0 ? (
              <button
                type="button"
                onClick={() => setShowResolved((value) => !value)}
                className="pb-2 text-xs text-muted-foreground underline-offset-2 hover:underline"
              >
                {showResolved ? "Hide" : "Show"} {resolvedThreads.length} resolved
              </button>
            ) : null}
            {showResolved
              ? resolvedThreads.map((thread) => (
                  <ThreadBlock key={thread.id} thread={thread} identity={identity} apply={apply} />
                ))
              : null}
          </div>
          <div className="shrink-0 px-4 pb-3">
            {opError !== null && <p className="pb-1 text-xs text-red-700">{opError}</p>}
            {identity === null ? (
              <p className="text-xs text-muted-foreground">Sign-in identity unavailable — comments are read-only.</p>
            ) : (
              <CommentComposer
                placeholder="Leave a comment…"
                submitLabel="Comment"
                onSubmit={(body) =>
                  apply((doc) => addThread(doc, { body, createdAt: nowIso(), ...identity }))
                }
              />
            )}
          </div>
        </>
      )}
    </div>
  );
}

function ThreadBlock({
  thread,
  identity,
  apply,
}: {
  thread: Thread;
  identity: CommentIdentity | null;
  apply: (op: DiscussionOp) => boolean;
}) {
  const [replyOpen, setReplyOpen] = useState(false);
  const resolved = thread.status === "resolved";
  return (
    <div className={cn("border-b border-border/50 py-2 last:border-b-0", resolved && "opacity-70")}>
      {thread.label !== null && (
        <p className="pb-1 font-mono text-[10px] text-muted-foreground">
          {thread.label}
          {resolved ? " · resolved" : ""}
        </p>
      )}
      {thread.comments.map((comment) => (
        <CommentRow
          key={comment.id}
          comment={comment}
          mine={identity !== null && comment.author === identity.author}
          apply={apply}
        />
      ))}
      <div className="flex items-center gap-2 pt-0.5 pl-8">
        {identity !== null && !resolved && !replyOpen ? (
          <button
            type="button"
            onClick={() => setReplyOpen(true)}
            className="text-xs text-muted-foreground underline-offset-2 hover:underline"
          >
            Reply
          </button>
        ) : null}
        <button
          type="button"
          onClick={() =>
            apply((doc) => setThreadStatus(doc, thread.id, resolved ? "open" : "resolved"))
          }
          className="flex items-center gap-1 text-xs text-muted-foreground underline-offset-2 hover:underline"
        >
          {resolved ? (
            <>
              <Undo2Icon aria-hidden className="size-3" /> Reopen
            </>
          ) : (
            <>
              <CheckCircle2Icon aria-hidden className="size-3" /> Resolve
            </>
          )}
        </button>
      </div>
      {replyOpen && identity !== null ? (
        <div className="pt-1.5 pl-8">
          <CommentComposer
            placeholder="Reply…"
            submitLabel="Reply"
            focusOnMount
            onCancel={() => setReplyOpen(false)}
            onSubmit={(body) => {
              const ok = apply((doc) =>
                addComment(doc, { threadId: thread.id, body, createdAt: nowIso(), ...identity }),
              );
              if (ok) setReplyOpen(false);
              return ok;
            }}
          />
        </div>
      ) : null}
    </div>
  );
}

function CommentRow({
  comment,
  mine,
  apply,
}: {
  comment: ThreadComment;
  mine: boolean;
  apply: (op: DiscussionOp) => boolean;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const name = comment.displayName ?? comment.author;
  return (
    <div className={cn("group flex gap-2 py-1.5", comment.inReplyTo !== null && "pl-6")}>
      <span
        aria-hidden
        className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold text-white"
        style={{ backgroundColor: authorColor(comment.author, 1) }}
      >
        {initials(name)}
      </span>
      <div className="min-w-0 flex-1">
        <p className="flex items-baseline gap-2 text-xs">
          <span className="font-medium">{name}</span>
          <time
            dateTime={comment.createdAt}
            title={formatUtcTimestamp(comment.createdAt)}
            className="text-muted-foreground"
          >
            {relativeTime(comment.createdAt)}
          </time>
          {comment.deleted || !mine ? null : (
            <span className="ml-auto hidden shrink-0 items-center gap-1 group-hover:flex">
              <button
                type="button"
                aria-label="Edit comment"
                onClick={() => setEditing(comment.body)}
                className="text-muted-foreground hover:text-foreground"
              >
                <PencilIcon aria-hidden className="size-3" />
              </button>
              <button
                type="button"
                aria-label="Delete comment"
                onClick={() => apply((doc) => deleteComment(doc, comment.id))}
                className="text-muted-foreground hover:text-destructive"
              >
                <Trash2Icon aria-hidden className="size-3" />
              </button>
            </span>
          )}
        </p>
        {comment.deleted ? (
          <p className="text-xs text-muted-foreground italic">Deleted.</p>
        ) : editing !== null ? (
          <CommentComposer
            placeholder="Edit comment…"
            submitLabel="Save"
            initialValue={editing}
            focusOnMount
            onCancel={() => setEditing(null)}
            onSubmit={(body) => {
              const ok = apply((doc) => editComment(doc, comment.id, body));
              if (ok) setEditing(null);
              return ok;
            }}
          />
        ) : (
          <div className="text-sm">
            {/* Same sanitization posture as the Preview tab: default rehype
                pipeline only — never pass rehypePlugins here. */}
            <MessageResponse loadingFallback={null} parseIncompleteMarkdown={false}>
              {comment.body}
            </MessageResponse>
          </div>
        )}
      </div>
    </div>
  );
}

function CommentComposer({
  placeholder,
  submitLabel,
  initialValue,
  focusOnMount = false,
  onSubmit,
  onCancel,
}: {
  placeholder: string;
  submitLabel: string;
  initialValue?: string;
  /** Reply/edit composers appear on user action and take focus then. */
  focusOnMount?: boolean;
  /** Returns whether the edit landed — the draft clears only on success. */
  onSubmit: (body: string) => boolean;
  onCancel?: () => void;
}) {
  const [draft, setDraft] = useState(initialValue ?? "");
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => {
    if (focusOnMount) textareaRef.current?.focus();
  }, [focusOnMount]);
  const submit = () => {
    if (draft.trim() === "") return;
    if (onSubmit(draft)) setDraft("");
  };
  return (
    <div className="flex flex-col gap-1.5">
      <Textarea
        ref={textareaRef}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        placeholder={placeholder}
        rows={2}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            submit();
          }
          if (event.key === "Escape" && onCancel !== undefined) {
            event.stopPropagation();
            onCancel();
          }
        }}
        className="min-h-0 resize-none text-sm"
      />
      <div className="flex items-center gap-2 self-end">
        {onCancel !== undefined && (
          <Button variant="ghost" size="sm" onClick={onCancel}>
            Cancel
          </Button>
        )}
        <Button size="sm" disabled={draft.trim() === ""} onClick={submit}>
          {submitLabel}
        </Button>
      </div>
    </div>
  );
}

function initials(name: string): string {
  const words = name.split(/[\s._@-]+/).filter(Boolean);
  const first = words[0]?.[0] ?? "?";
  const second = words.length > 1 ? (words[1]?.[0] ?? "") : "";
  return (first + second).toUpperCase();
}

function nowIso(): string {
  return new Date().toISOString();
}

function relativeTime(iso: string): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return iso;
  const seconds = Math.round((Date.now() - then) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.round(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.round(months / 12)}y ago`;
}
