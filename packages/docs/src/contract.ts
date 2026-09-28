// docs/contract.ts — the two processors (frames.ts). THE DOC PROCESSOR, one per opened doc's
// context, reduces nothing: the live text is a Y.Doc in the facet's own storage (processor.ts), too
// big and too hot for a reduce checkpoint, which is written only after durable events anyway. THE
// DOCS PROCESSOR, on the project's root, reduces which docs have been opened (root.ts).
import { z } from "zod";
import { defineProcessorContract } from "iterate/stream/processor";
import { COMMIT_NOTICED, DOC_OPENED, EDIT_FRAME } from "./frames.ts";

export const DocContract = defineProcessorContract({
  slug: "doc",
  version: "1",
  description:
    "Holds an open doc's text as Yjs, applies its editors' edits, and autosaves it to /repos/docs.",
  stateSchema: z.object({}),
  consumes: [EDIT_FRAME, COMMIT_NOTICED],
  emits: [EDIT_FRAME],
});

export const DocsContract = defineProcessorContract({
  slug: "docs",
  version: "1",
  description: "Tells each opened doc's processor when a commit to /repos/docs changed its doc.",
  stateSchema: z.object({ opened: z.array(z.string()).default([]) }),
  consumes: ["events.iterate.com/repo/commit-completed", DOC_OPENED],
  emits: [COMMIT_NOTICED],
});
