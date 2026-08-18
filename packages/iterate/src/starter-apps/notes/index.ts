// Project-worker glue for the NotesApp: fan committed events on the notes
// workspace's stream into the app's Durable Object (guestbook/media shape —
// note volume doesn't warrant a wake-processor subscription). No capability
// mount: notes are ordinary workspace documents, and agents find them with
// glob/readFiles like any other file (convergence decision D6).
import type { DynamicWorkerCapability, ItxBinding, StreamEvent } from "../../sdk.ts";
import { notesWorkerRef, notesWorkspacePath } from "./app-ref.ts";
import type { NotesApp as NotesWorker } from "./worker.ts";

export { notesRepoPath, notesWorkerRef, notesWorkspacePath } from "./app-ref.ts";

export const NotesApp = {
  create(env: { ITX: Pick<ItxBinding, "get"> }) {
    return {
      async processEvent(event: StreamEvent): Promise<void> {
        if (event.path !== notesWorkspacePath) return;
        // Only the notes vocabulary wakes the app — the workspace's own
        // lifecycle events (created/configured) and typing ephemera are not
        // consumed by the processor, so skipping them here saves a dial.
        if (!event.type.startsWith("events.iterate.com/notes/")) return;
        using project = await env.ITX.get();
        using worker = project.workers.get(notesWorkerRef) as DynamicWorkerCapability<
          Pick<NotesWorker, "syncEvent">
        >;
        await worker.syncEvent(event);
      },
    };
  },
};
