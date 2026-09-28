// docs/frames.ts — HOW A DOC IS CO-EDITED: what the Docs app's browsers and the doc's processor
// (processor.ts) say to each other on the doc's own context. Each open doc is one context,
// `/docs/<path in /repos/docs>`. Its text is one Yjs `Y.Text` ("file", the file's bytes); every edit
// is a Yjs update, and each update travels as an EPHEMERAL event: nothing durable per keystroke,
// and a browser's existing socket carries it (facets take no WebSocket of their own).
//
//   docs/edit-frame       a Yjs update, from a browser or from the processor (a merged commit)
//   docs/awareness-frame  who is here and where their cursor is (y-protocols awareness); browsers only
//   docs/commit-noticed   /repos/docs moved and the doc changed: the processor takes the commit in
//
// On the project's root, the docs processor (root.ts) keeps which docs have been opened
// (`docs/opened`, durable, one per doc) and turns each commit to /repos/docs into a
// `docs/commit-noticed` on the opened docs it changed, so a commit an agent makes reaches the open
// editors, and a doc no one has opened gets no context.
//
// An ephemeral push can be dropped under load, and nothing redelivers it. Yjs updates can be applied
// in any order and more than once, so a browser syncs again with the processor (`sync`, by state
// vector, both ways) when an update arrives that needs one it never got, when a send fails, and after
// each save.
import { z } from "zod";

export const EDIT_FRAME = "docs/edit-frame";
export const AWARENESS_FRAME = "docs/awareness-frame";
export const COMMIT_NOTICED = "docs/commit-noticed";
export const DOC_OPENED = "docs/opened";
export const DOCS_REPO = "/repos/docs";

/** `update`: the Yjs update, base64. `client`: the sender's Yjs client id ("processor" for the
 *  processor's own), so a sender can skip the echo of its own frames. */
export const EditFrame = z.object({
  update: z.string(),
  client: z.union([z.number(), z.literal("processor")]),
});
export const AwarenessFrame = z.object({ update: z.string(), client: z.number() });

/** The context that co-edits the doc at `path` (relative to /repos/docs, `.md` included). */
export const docContextPath = (path: string) => `/docs/${path}`;

/** The doc a context co-edits: its path in /repos/docs. */
export function docPathOf(contextPath: string) {
  if (!contextPath.startsWith("/docs/")) throw new Error(`not a doc's context: ${contextPath}`);
  return contextPath.slice("/docs/".length);
}

/** The processor's live state, what the page shows under the editor. `commitOid`: the commit the
 *  text was last saved as (or read at); `dirty`: edits since then are waiting to be saved;
 *  `savedBy`: whose edits the last save committed; `saveError`: why the last save failed, when it
 *  did (the text is kept, and the next edit saves again). */
export const DocLiveState = z.object({
  commitOid: z.string().nullable(),
  dirty: z.boolean(),
  savedBy: z.array(z.string()),
  saveError: z.string().nullable(),
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
