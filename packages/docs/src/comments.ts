// docs/comments.ts — COMMENTS ON A DOC: durable events on the doc's own context (frames.ts), never
// text in the file. A thread points at the text it's about by quoting it (anchor.ts), or at the
// whole doc; its comments are the events that added and replied to it. Anyone on the project may
// resolve or reopen a thread; only a comment's author may edit or delete it. The author is the
// event's `source`, which the platform stamps: a person's email, or the context an agent wrote from.
// A comment an agent wrote for a person (Claude Code over MCP, as that person) says so in `via`, the
// agent's own word for itself; the event's `source.grant` is the connection it really came through.
//
//   docs/comment-added       a new thread: its id, its quote (or none, for the whole doc), its first comment
//   docs/comment-replied     a comment on a thread
//   docs/comment-edited      a comment's new body, by its author
//   docs/comment-deleted     a comment gone, by its author (the thread goes with its last comment)
//   docs/comment-resolved    a thread done; docs/comment-reopened undoes it
//   docs/comment-reanchored  the doc's processor, after a save: the thread's quote refreshed from
//                            the text it now matches loosely, or null when nothing matches (detached)
import { z } from "zod";
import type { StreamEvent } from "iterate/stream/processor";

export const COMMENT_ADDED = "docs/comment-added";
export const COMMENT_REPLIED = "docs/comment-replied";
export const COMMENT_EDITED = "docs/comment-edited";
export const COMMENT_DELETED = "docs/comment-deleted";
export const COMMENT_RESOLVED = "docs/comment-resolved";
export const COMMENT_REOPENED = "docs/comment-reopened";
export const COMMENT_REANCHORED = "docs/comment-reanchored";

/** Every comment event, as a doc's processor consumes them. */
export const commentEvents = [
  COMMENT_ADDED,
  COMMENT_REPLIED,
  COMMENT_EDITED,
  COMMENT_DELETED,
  COMMENT_RESOLVED,
  COMMENT_REOPENED,
  COMMENT_REANCHORED,
];

export const Quote = z.object({ exact: z.string().min(1), prefix: z.string(), suffix: z.string() });

/** The agent that wrote a comment on its person's behalf, as it names itself ("Claude Code"). */
const Via = z.string().trim().min(1).max(40).optional();

export const CommentAdded = z.object({
  thread: z.string().min(1),
  quote: Quote.nullable(),
  body: z.string().min(1),
  via: Via,
});
export const CommentReplied = z.object({
  thread: z.string(),
  comment: z.string().min(1),
  body: z.string().min(1),
  via: Via,
});
export const CommentEdited = z.object({
  thread: z.string(),
  comment: z.string(),
  body: z.string().min(1),
});
export const CommentDeleted = z.object({ thread: z.string(), comment: z.string() });
export const ThreadRef = z.object({ thread: z.string() });
export const CommentReanchored = z.object({ thread: z.string(), quote: Quote.nullable() });

export const Comment = z.object({
  /** the thread's id for its first comment */
  id: z.string(),
  author: z.string(),
  /** the agent that wrote it for its author, when one did; absent in a build before it, whose
   *  live state a newer page still reads */
  via: z.string().nullable().default(null),
  body: z.string(),
  at: z.string(),
  edited: z.boolean(),
});
export type Comment = z.infer<typeof Comment>;

export const CommentThread = z.object({
  id: z.string(),
  /** what it's about; null for the whole doc */
  quote: Quote.nullable(),
  /** its quote matches nothing in the text as last saved */
  detached: z.boolean(),
  resolved: z.object({ by: z.string(), at: z.string() }).nullable(),
  comments: z.array(Comment),
});
export type CommentThread = z.infer<typeof CommentThread>;

/** Who wrote an event: the person, or the person a script ran for (an agent over MCP, as them),
 *  else the context it was written from (an agent's own). */
export function authorOf(event: Pick<StreamEvent, "source">) {
  const person = event.source.principal || event.source.onBehalfOf?.principal;
  return person?.email || person?.actor || event.source.origin;
}

/** The threads after `event`; the same array when it changes nothing (not a comment event, a
 *  payload that doesn't parse, an edit by someone else). */
export function reduceComments(threads: CommentThread[], event: StreamEvent): CommentThread[] {
  const author = authorOf(event);
  const update = (id: string, change: (thread: CommentThread) => CommentThread | null) => {
    const index = threads.findIndex((thread) => thread.id === id);
    if (index < 0) return threads;
    const next = change(threads[index]!);
    if (next === threads[index]) return threads;
    return next
      ? threads.map((thread, i) => (i === index ? next : thread))
      : threads.filter((_, i) => i !== index);
  };
  switch (event.type) {
    case COMMENT_ADDED: {
      const added = CommentAdded.safeParse(event.payload);
      if (!added.success || threads.some((thread) => thread.id === added.data.thread))
        return threads;
      const { thread, quote, body, via } = added.data;
      return [
        ...threads,
        {
          id: thread,
          quote,
          detached: false,
          resolved: null,
          comments: [
            { id: thread, author, via: via || null, body, at: event.createdAt, edited: false },
          ],
        },
      ];
    }
    case COMMENT_REPLIED: {
      const reply = CommentReplied.safeParse(event.payload);
      if (!reply.success) return threads;
      const { comment, body, via } = reply.data;
      return update(reply.data.thread, (thread) =>
        thread.comments.some((each) => each.id === comment)
          ? thread
          : {
              ...thread,
              comments: [
                ...thread.comments,
                {
                  id: comment,
                  author,
                  via: via || null,
                  body,
                  at: event.createdAt,
                  edited: false,
                },
              ],
            },
      );
    }
    case COMMENT_EDITED: {
      const edit = CommentEdited.safeParse(event.payload);
      if (!edit.success) return threads;
      return update(edit.data.thread, (thread) => {
        const target = thread.comments.find((each) => each.id === edit.data.comment);
        if (!target || target.author !== author) return thread;
        return {
          ...thread,
          comments: thread.comments.map((each) =>
            each === target ? { ...each, body: edit.data.body, edited: true } : each,
          ),
        };
      });
    }
    case COMMENT_DELETED: {
      const deletion = CommentDeleted.safeParse(event.payload);
      if (!deletion.success) return threads;
      return update(deletion.data.thread, (thread) => {
        const target = thread.comments.find((each) => each.id === deletion.data.comment);
        if (!target || target.author !== author) return thread;
        const comments = thread.comments.filter((each) => each !== target);
        return comments.length > 0 ? { ...thread, comments } : null;
      });
    }
    case COMMENT_RESOLVED:
    case COMMENT_REOPENED: {
      const ref = ThreadRef.safeParse(event.payload);
      if (!ref.success) return threads;
      return update(ref.data.thread, (thread) => ({
        ...thread,
        resolved: event.type === COMMENT_RESOLVED ? { by: author, at: event.createdAt } : null,
      }));
    }
    case COMMENT_REANCHORED: {
      const anchor = CommentReanchored.safeParse(event.payload);
      if (!anchor.success) return threads;
      // detached keeps the old quote, to show what the thread was about
      return update(anchor.data.thread, (thread) =>
        anchor.data.quote
          ? { ...thread, quote: anchor.data.quote, detached: false }
          : { ...thread, detached: true },
      );
    }
    default:
      return threads;
  }
}
