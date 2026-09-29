// docs/frames.ts — HOW A DOC IS CO-EDITED: what the Docs app's browsers and the doc's processor
// (processor.ts) say to each other on the doc's own context. A doc is a markdown file in one of the
// project's repos, and each open doc is one context, `/docs/<repo name>/<path in the repo>`
// (/repos/config's tasks/plan.md is /docs/config/tasks/plan.md). Its text is one Yjs `Y.Text`
// ("file", the file's bytes); every edit is a Yjs update, and each update travels as an EPHEMERAL
// event: nothing durable per keystroke, and a browser's existing socket carries it (facets take no
// WebSocket of their own).
//
//   docs/edit-frame       a Yjs update, from a browser or from the processor (a merged commit)
//   docs/awareness-frame  who is here and where their cursor is (y-protocols awareness); browsers only
//   docs/left             a browser closed the doc: when it was the last, the processor saves now
//   docs/commit-noticed   the repo moved and the doc changed: the processor takes the commit in
//
// On the project's root, the docs processor (root.ts) keeps which docs have been opened
// (`docs/opened`, durable, one per doc) and turns each commit to a repo into a
// `docs/commit-noticed` on the opened docs it changed, so a commit an agent makes reaches the open
// editors, and a doc no one has opened gets no context.
//
// An ephemeral push can be dropped under load, and nothing redelivers it. Yjs updates can be applied
// in any order and more than once, so a browser syncs again with the processor (`sync`, by state
// vector, both ways) when an update arrives that needs one it never got, after each save, and after
// a send failed: when asked to try again, and before it leaves the doc.
import { z } from "zod";
import { CommentThread } from "./comments.ts";

export const EDIT_FRAME = "docs/edit-frame";
export const AWARENESS_FRAME = "docs/awareness-frame";
export const COMMIT_NOTICED = "docs/commit-noticed";
export const DOC_LEFT = "docs/left";
export const DOC_OPENED = "docs/opened";

/** `update`: the Yjs update, base64. `client`: the sender's Yjs client id ("processor" for the
 *  processor's own), so a sender can skip the echo of its own frames. */
export const EditFrame = z.object({
  update: z.string(),
  client: z.union([z.number(), z.literal("processor")]),
});
export const AwarenessFrame = z.object({ update: z.string(), client: z.number() });
/** `client`: the Yjs client id of the tab that closed the doc. */
export const DocLeft = z.object({ client: z.number() });

/** A doc: its repo (`/repos/<name>`) and its path in the repo, `.md` included. */
export type DocRef = { repo: string; path: string };

/** The context that co-edits `doc`. */
export function docContextPath(doc: DocRef) {
  const name = /^\/repos\/([^/]+)$/.exec(doc.repo)?.[1];
  if (!name) throw new Error(`not a repo Docs edits: ${doc.repo} (a repo is /repos/<name>)`);
  return `/docs/${name}/${doc.path}`;
}

/** The doc a context co-edits. */
export function docOf(contextPath: string): DocRef {
  const [, name, path] = /^\/docs\/([^/]+)\/(.+)$/.exec(contextPath) || [];
  if (!name || !path) throw new Error(`not a doc's context: ${contextPath}`);
  return { repo: `/repos/${name}`, path };
}

/** The processor's live state, what the page shows around the editor. `commitOid`: the commit the
 *  text was last saved as (or read at); `dirty`: edits since then are waiting to be saved;
 *  `savedBy`: whose edits the last save committed; `saveError`: why the last save failed, when it
 *  did (the text is kept, and the next edit saves again); `threads`: the doc's comments
 *  (comments.ts), in the order they were started. */
export const DocLiveState = z.object({
  commitOid: z.string().nullable(),
  dirty: z.boolean(),
  savedBy: z.array(z.string()),
  saveError: z.string().nullable(),
  threads: z.array(CommentThread),
});
export type DocLiveState = z.infer<typeof DocLiveState>;

export function toBase64(bytes: Uint8Array) {
  let binary = "";
  // in chunks: a spread of a big array overflows the call stack
  for (let i = 0; i < bytes.length; i += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

export function fromBase64(base64: string) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
