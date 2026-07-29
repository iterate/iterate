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
  resolveThreadAnchor,
  setThreadStatus,
} from "iterate/annotated-markdown";
import type { AnchorResolution, Thread, ThreadComment } from "iterate/annotated-markdown";
import { authorColor } from "../lib/collab-redline.ts";
import { useDiscussionApply } from "../lib/use-discussion-apply.ts";
import type { DiscussionOp } from "../lib/use-discussion-apply.ts";

export type CommentIdentity = { author: string; authorDisplay?: string };

/**
 * Linear-style discussion for one task file, backed by the annotated-markdown
 * codec: threads live at the end of the markdown file itself, so every
 * mutation here is an ordinary whole-file transform routed through the same
 * live-editor/write lane as any other task edit.
 */
export function TaskComments({
  source,
  identity,
  busy,
  onTransform,
  selectedThreadId = null,
  onSelectThread,
}: {
  source: string;
  identity: CommentIdentity | null;
  /** True while the file's live editor is still attaching. Mutations must
   * wait it out: the raw-write fallback lane races the arriving session,
   * which then flushes its older snapshot over the write. */
  busy: boolean;
  /** Route a whole-file transform to the live editor or the write lane;
   * resolves whether it landed (the write lane can roll back). */
  onTransform: (transform: (source: string) => string) => Promise<boolean>;
  /** Two-way selection sync with the preview's highlights. */
  selectedThreadId?: string | null;
  onSelectThread?: (threadId: string | null) => void;
}) {
  const parsed = useMemo(() => parseAnnotatedMarkdown(source), [source]);
  const [open, setOpen] = useState(true);
  const [showResolved, setShowResolved] = useState(false);
  const { apply, opError } = useDiscussionApply({ busy, onTransform });

  const threads = useMemo(
    () => (parsed.kind === "structured" ? (parsed.discussion?.threads ?? []) : []),
    [parsed],
  );
  const body = parsed.kind === "structured" ? parsed.body : "";
  // Anchored threads sort by where their text sits in the document, like the
  // margin of a review; document-level threads keep append order below them.
  const resolutions = useMemo(() => {
    const map = new Map<string, AnchorResolution>();
    for (const thread of threads) {
      if (thread.anchor === null) continue;
      map.set(thread.id, resolveThreadAnchor(body, thread.id, thread.anchor.selector));
    }
    return map;
  }, [body, threads]);
  const threadKind = (thread: Thread): number => (thread.anchor !== null ? 0 : 1);
  const positionOf = (thread: Thread): number =>
    resolutions.get(thread.id)?.range?.start ?? Number.MAX_SAFE_INTEGER;
  const byPosition = (a: Thread, b: Thread): number =>
    threadKind(a) !== threadKind(b)
      ? threadKind(a) - threadKind(b)
      : positionOf(a) - positionOf(b);
  const openThreads = threads.filter((thread) => thread.status === "open").sort(byPosition);
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
              <ThreadBlock
                key={thread.id}
                thread={thread}
                identity={identity}
                apply={apply}
                resolution={resolutions.get(thread.id) ?? null}
                selected={thread.id === selectedThreadId}
                onSelect={onSelectThread}
              />
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
                  <ThreadBlock
                    key={thread.id}
                    thread={thread}
                    identity={identity}
                    apply={apply}
                    resolution={resolutions.get(thread.id) ?? null}
                    selected={thread.id === selectedThreadId}
                    onSelect={onSelectThread}
                  />
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
  resolution,
  selected,
  onSelect,
}: {
  thread: Thread;
  identity: CommentIdentity | null;
  apply: (op: DiscussionOp) => Promise<boolean>;
  /** Null for document-level threads (no anchor). */
  resolution: AnchorResolution | null;
  selected: boolean;
  onSelect?: (threadId: string | null) => void;
}) {
  const [replyOpen, setReplyOpen] = useState(false);
  const blockRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (selected) blockRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [selected]);
  const resolved = thread.status === "resolved";
  const quote = thread.anchor?.selector.quote.exact ?? null;
  return (
    // eslint-disable-next-line jsx-a11y/no-static-element-interactions, jsx-a11y/click-events-have-key-events -- selection sync only; every action inside is a real button
    <div
      ref={blockRef}
      onClick={onSelect === undefined ? undefined : () => onSelect(thread.id)}
      className={cn(
        "-mx-2 border-b border-border/50 px-2 py-2 last:border-b-0",
        resolved && "opacity-70",
        selected && "rounded-md bg-primary/5 ring-1 ring-primary/30",
      )}
    >
      {thread.label !== null && (
        <p className="pb-1 font-mono text-[10px] text-muted-foreground">
          {thread.label}
          {resolved ? " · resolved" : ""}
        </p>
      )}
      {quote !== null && (
        <p
          className="mb-1.5 truncate border-l-2 pl-2 text-xs text-muted-foreground italic"
          style={{ borderColor: authorColor(thread.comments[0]?.author ?? "someone", 0.8) }}
          title={quote}
        >
          {quote}
        </p>
      )}
      {resolution !== null && resolution.state !== "attached" && (
        <p className="mb-1 text-[10px] font-medium tracking-wide text-amber-700 uppercase">
          {resolution.state === "needs_review" ? "anchor needs review" : "anchor lost"}
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
        {identity !== null ? (
          <button
            type="button"
            onClick={() =>
              void apply((doc) => setThreadStatus(doc, thread.id, resolved ? "open" : "resolved"))
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
        ) : null}
      </div>
      {replyOpen && identity !== null ? (
        <div className="pt-1.5 pl-8">
          <CommentComposer
            placeholder="Reply…"
            submitLabel="Reply"
            focusOnMount
            onCancel={() => setReplyOpen(false)}
            onSubmit={(body) =>
              apply((doc) =>
                addComment(doc, { threadId: thread.id, body, createdAt: nowIso(), ...identity }),
              ).then((ok) => {
                if (ok) setReplyOpen(false);
                return ok;
              })
            }
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
  apply: (op: DiscussionOp) => Promise<boolean>;
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
          {comment.modifiedAt !== null && !comment.deleted ? (
            <span
              className="text-[10px] text-muted-foreground/70"
              title={`edited ${formatUtcTimestamp(comment.modifiedAt)}`}
            >
              (edited)
            </span>
          ) : null}
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
                onClick={() => void apply((doc) => deleteComment(doc, comment.id))}
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
            onSubmit={(body) =>
              apply((doc) => editComment(doc, comment.id, body, { modifiedAt: nowIso() })).then((ok) => {
                if (ok) setEditing(null);
                return ok;
              })
            }
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

export function CommentComposer({
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
  /** Resolves whether the edit LANDED (the write lane is async and can roll
   * back) — the draft clears only on success, so nothing typed is lost. */
  onSubmit: (body: string) => Promise<boolean>;
  onCancel?: () => void;
}) {
  const [draft, setDraft] = useState(initialValue ?? "");
  // State drives the disabled button; the ref closes the same-tick window
  // (state lands next render, so a double ⌘-Enter would submit twice).
  const [submitting, setSubmitting] = useState(false);
  const inFlight = useRef(false);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => {
    if (focusOnMount) textareaRef.current?.focus();
  }, [focusOnMount]);
  const submit = () => {
    if (inFlight.current || draft.trim() === "") return;
    inFlight.current = true;
    setSubmitting(true);
    void onSubmit(draft)
      .then((ok) => {
        if (ok) setDraft("");
      })
      .finally(() => {
        inFlight.current = false;
        setSubmitting(false);
      });
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
        <Button size="sm" disabled={submitting || draft.trim() === ""} onClick={submit}>
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
