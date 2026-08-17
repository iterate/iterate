// The NotesApp's physical identity: a stable durable key preserves its
// processor storage across implementation updates. The literal lives in
// ref.ts (dependency-free for the mobile app); this module holds the
// satisfies check against the real ref type.
import type { StatefulDynamicWorkerRef } from "../../sdk.ts";
import { notesWorkerRef as notesWorkerRefLiteral } from "./ref.ts";

export { notesRepoPath, notesWorkspacePath } from "./ref.ts";

export const notesWorkerRef = notesWorkerRefLiteral satisfies StatefulDynamicWorkerRef;
