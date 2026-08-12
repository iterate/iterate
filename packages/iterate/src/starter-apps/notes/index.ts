// Project-worker glue for the NotesApp: fan committed /notes events into the
// app's Durable Object (guestbook/media shape — note volume doesn't warrant a
// wake-processor subscription), and on project/worker-updated mount the query
// surface at `itx.notes` as a durable itx-call capability so agents answer
// "what did I note about X?" with itx.notes.search(...).
import type { DynamicWorkerCapability, ItxBinding, StreamEvent } from "../../sdk.ts";
import { notesStreamPath, notesWorkerRef } from "./app-ref.ts";
import type { NotesApp as NotesWorker } from "./worker.ts";

export { notesStreamPath, notesWorkerRef } from "./app-ref.ts";

export const NotesApp = {
  create(env: { ITX: Pick<ItxBinding, "get"> }) {
    return {
      async processEvent(event: StreamEvent): Promise<void> {
        if (event.path === notesStreamPath) {
          using project = await env.ITX.get();
          using worker = project.workers.get(notesWorkerRef) as DynamicWorkerCapability<
            Pick<NotesWorker, "syncEvent">
          >;
          await worker.syncEvent(event);
          return;
        }
        if (event.type === "events.iterate.com/project/worker-updated" && event.path === "/") {
          using project = await env.ITX.get();
          // Re-providing on each worker update keeps the mount pointing at
          // the current ref; the host keeps one current mount per path.
          await project.capabilityHosts.get("/").provideCapability({
            type: "itx-call",
            path: ["notes"],
            expression: ["workers", ["get", notesWorkerRef]],
            flattenNestedPaths: true,
            instructions:
              "Notes the user captured from the mobile app, searchable by content. " +
              "search({ q?, limit? }) keyword-matches titles, note text, attachment filenames, " +
              "and tags, newest first, returning signed attachment URLs. " +
              "list({ limit? }) is the unfiltered newest; get(noteKey) one note.",
            // No `types`: the provide-time compile gate rejects strings it
            // cannot check, and a failure here would get the worker-updated
            // event skipped (delivery is onFailingEvent: skip). Untyped +
            // instructions beats a mount that never happens.
          });
        }
      },
    };
  },
};
