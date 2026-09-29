// docs/contract.ts — the two processors (frames.ts). THE DOC PROCESSOR, one per opened doc's
// context, reduces the doc's comments (comments.ts); the live text is a Y.Doc in the facet's own
// storage instead (processor.ts), too big and too hot for a reduce checkpoint, which is written only
// after durable events anyway. THE
// DOCS PROCESSOR, on the project's root, reduces which docs have been opened, by their contexts'
// paths (root.ts).
import { z } from "zod";
import { defineProcessorContract } from "iterate/stream/processor";
import { COMMENT_REANCHORED, CommentThread, commentEvents } from "./comments.ts";
import { COMMIT_NOTICED, DOC_LEFT, DOC_OPENED, EDIT_FRAME } from "./frames.ts";

export const DocContract = defineProcessorContract({
  slug: "doc",
  version: "2",
  description:
    "Holds an open doc's text as Yjs, applies its editors' edits, autosaves it to its repo, and reduces its comments.",
  stateSchema: z.object({ threads: z.array(CommentThread).default([]) }),
  consumes: [EDIT_FRAME, COMMIT_NOTICED, DOC_LEFT, ...commentEvents],
  emits: [EDIT_FRAME, COMMENT_REANCHORED],
});

export const DocsContract = defineProcessorContract({
  slug: "docs",
  version: "1",
  description: "Tells each opened doc's processor when a commit to its repo changed its doc.",
  stateSchema: z.object({ opened: z.array(z.string()).default([]) }),
  consumes: ["events.iterate.com/repo/commit-completed", DOC_OPENED],
  emits: [COMMIT_NOTICED],
});
