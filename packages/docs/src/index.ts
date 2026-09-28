// @iterate-com/docs — live co-editing for a project's docs (frames.ts): one processor per open doc
// holds its text and autosaves it to /repos/docs (processor.ts). The Docs app installs it on each
// doc's context as the doc opens (install.ts).
export { DocDurableObject, DocsDurableObject } from "./durable-object.ts";
