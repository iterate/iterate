import { useMutation } from "@tanstack/react-query";
import { Check, Pencil, RotateCcw, Trash2 } from "lucide-react";
import type { Quote } from "@iterate-com/docs/anchor";
import type { Comment } from "@iterate-com/docs/comments";
import { Button } from "@iterate-com/ui/components/ui/button";
import { Textarea } from "@iterate-com/ui/components/ui/textarea";
import { cn } from "cn";
import type { DocSession, DocSessionState, ThreadView } from "../editor/doc-session.ts";

/** The doc's comments beside its text: the one being written, the open threads in the order their
 *  text comes, those whose text is gone, and the resolved ones folded away. */
export function CommentsPanel({
  session,
  state,
}: {
  session: DocSession;
  state: Pick<DocSessionState, "threads" | "active" | "draft" | "editing">;
}) {
  const open = state.threads.filter((thread) => !thread.resolved);
  const card = (thread: ThreadView) => (
    <ThreadCard
      key={thread.id}
      session={session}
      thread={thread}
      active={state.active === thread.id}
      editing={state.editing && state.editing.thread === thread.id ? state.editing.comment : null}
    />
  );
  const gone = open.filter((thread) => !thread.attached);
  const resolved = state.threads.filter((thread) => thread.resolved);
  return (
    <aside
      aria-label="Comments"
      className="flex shrink-0 flex-col gap-3 border-t p-3 md:sticky md:top-11 md:max-h-[calc(100svh-5.5rem)] md:w-80 md:self-start md:overflow-y-auto md:border-t-0 md:border-l"
    >
      {state.draft ? (
        <article
          aria-label="New comment"
          className="flex flex-col gap-2 rounded-lg border bg-card p-3 text-sm shadow-xs ring-2 ring-amber-300"
        >
          <Quoted quote={state.draft.quote} gone={false} />
          <CommentForm
            label="Comment"
            placeholder="Add a comment…"
            submit="Comment"
            // posted, it stays until its thread comes back and takes its place
            onSubmit={(body) => session.postDraft(body)}
            onCancel={() => session.cancelDraft()}
            keepPending
          />
        </article>
      ) : null}
      {open.filter((thread) => thread.attached).map(card)}
      {gone.length > 0 ? (
        <>
          <h3 className="pt-1 text-xs text-muted-foreground">On text that&apos;s gone</h3>
          {gone.map(card)}
        </>
      ) : null}
      {resolved.length > 0 ? (
        <details className="text-sm">
          <summary className="cursor-pointer text-xs text-muted-foreground">
            Resolved ({resolved.length})
          </summary>
          <div className="mt-2 flex flex-col gap-3">{resolved.map(card)}</div>
        </details>
      ) : null}
    </aside>
  );
}

function ThreadCard({
  session,
  thread,
  active,
  editing,
}: {
  session: DocSession;
  thread: ThreadView;
  active: boolean;
  /** which of its comments this person is editing */
  editing: string | null;
}) {
  const me = session.options.user.name;
  return (
    <article
      aria-label={thread.quote ? `Comment on “${thread.quote.exact}”` : "Comment on the doc"}
      aria-current={active || undefined}
      className={cn(
        "flex flex-col gap-2 rounded-lg border bg-card p-3 text-sm shadow-xs",
        active ? "ring-2 ring-amber-300" : "cursor-pointer",
        thread.resolved && "opacity-80",
      )}
      onClick={() => {
        if (!active) session.focusThread(thread.id);
      }}
    >
      <div className="flex items-start justify-between gap-2">
        <Quoted quote={thread.quote} gone={!thread.attached} />
        {thread.resolved ? (
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label="Reopen"
            title={`Resolved by ${nameOf(thread.resolved.by)}. Reopen`}
            onClick={() => void session.reopen(thread.id)}
          >
            <RotateCcw />
          </Button>
        ) : (
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label="Resolve"
            title="Resolve"
            onClick={() => void session.resolve(thread.id)}
          >
            <Check />
          </Button>
        )}
      </div>
      <ol className="flex flex-col gap-2">
        {thread.comments.map((comment) => (
          <CommentItem
            key={comment.id}
            comment={comment}
            mine={comment.author === me && active}
            editing={editing === comment.id}
            onEdit={() => session.startEditing(thread.id, comment.id)}
            onSave={(body) => session.editComment(thread.id, comment.id, body)}
            onCancel={() => session.stopEditing()}
            onDelete={() => session.deleteComment(thread.id, comment.id)}
          />
        ))}
      </ol>
      {thread.resolved ? (
        <p className="text-xs text-muted-foreground">Resolved by {nameOf(thread.resolved.by)}</p>
      ) : active ? (
        <CommentForm
          label="Reply"
          placeholder="Reply…"
          submit="Reply"
          onSubmit={(body) => session.reply(thread.id, body)}
        />
      ) : null}
    </article>
  );
}

function CommentItem({
  comment,
  mine,
  editing,
  onEdit,
  onSave,
  onCancel,
  onDelete,
}: {
  comment: Comment;
  /** this person's own, on the selected thread: it can be edited and deleted */
  mine: boolean;
  editing: boolean;
  onEdit: () => void;
  onSave: (body: string) => Promise<unknown>;
  onCancel: () => void;
  onDelete: () => Promise<unknown>;
}) {
  const remove = useMutation({ mutationFn: onDelete });
  return (
    <li className="flex flex-col gap-0.5">
      <div className="flex items-baseline justify-between gap-2">
        <span title={comment.author}>
          <span className="font-medium">{nameOf(comment.author)}</span>
          {/* the agent that wrote it for them, as it names itself */}
          {comment.via ? <span className="text-muted-foreground"> · {comment.via}</span> : null}
        </span>
        <time dateTime={comment.at} className="text-xs text-muted-foreground">
          {when.format(new Date(comment.at))}
        </time>
      </div>
      {editing ? (
        <CommentForm
          label="Edit comment"
          placeholder=""
          submit="Save"
          defaultValue={comment.body}
          onSubmit={onSave}
          onCancel={onCancel}
        />
      ) : (
        <p className="whitespace-pre-wrap">
          {comment.body}
          {comment.edited ? <span className="text-xs text-muted-foreground"> (edited)</span> : null}
        </p>
      )}
      {mine && !editing ? (
        <div className="flex gap-1">
          <Button size="icon-xs" variant="ghost" aria-label="Edit" title="Edit" onClick={onEdit}>
            <Pencil />
          </Button>
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label="Delete"
            title="Delete"
            disabled={remove.isPending}
            onClick={() => remove.mutate()}
          >
            <Trash2 />
          </Button>
        </div>
      ) : null}
    </li>
  );
}

/** What a thread is about: its quote, struck through when the text is gone; nothing for the whole
 *  doc. */
function Quoted({ quote, gone }: { quote: Quote | null; gone: boolean }) {
  if (!quote) return <p className="text-xs text-muted-foreground">On the whole doc</p>;
  return (
    <blockquote
      className={cn(
        "line-clamp-2 border-l-2 border-amber-400 pl-2 text-xs text-muted-foreground",
        gone && "line-through",
      )}
    >
      {quote.exact}
    </blockquote>
  );
}

/** A comment's text box: ⌘↩ posts, Escape cancels. `keepPending`: stays disabled once posted, for
 *  a draft that's replaced when its thread arrives. */
function CommentForm({
  label,
  placeholder,
  submit,
  defaultValue,
  onSubmit,
  onCancel,
  keepPending,
}: {
  label: string;
  placeholder: string;
  submit: string;
  defaultValue?: string;
  onSubmit: (body: string) => Promise<unknown>;
  onCancel?: () => void;
  keepPending?: boolean;
}) {
  const post = useMutation({ mutationFn: onSubmit });
  const waiting = post.isPending || (keepPending && post.isSuccess);
  return (
    <form
      className="flex flex-col gap-1.5"
      onSubmit={(event) => {
        event.preventDefault();
        const form = event.currentTarget;
        const body = String(new FormData(form).get("body") || "").trim();
        if (body) post.mutate(body, { onSuccess: () => form.reset() });
      }}
    >
      <Textarea
        name="body"
        aria-label={label}
        placeholder={placeholder}
        defaultValue={defaultValue}
        rows={2}
        autoFocus={Boolean(onCancel)}
        className="min-h-0 text-sm"
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            event.currentTarget.form?.requestSubmit();
          }
          if (event.key === "Escape" && onCancel) onCancel();
        }}
      />
      {post.error ? <p className="text-xs text-destructive">{post.error.message}</p> : null}
      <div className="flex justify-end gap-1">
        {onCancel ? (
          <Button type="button" size="xs" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        ) : null}
        <Button type="submit" size="xs" disabled={waiting}>
          {waiting ? "Posting…" : submit}
        </Button>
      </div>
    </form>
  );
}

const when = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

/** A person by the name part of their email; an agent by the context it wrote from. */
function nameOf(author: string) {
  return author.includes("@") ? author.split("@")[0]! : author;
}
