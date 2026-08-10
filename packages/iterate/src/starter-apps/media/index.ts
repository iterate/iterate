// Project-worker glue for the MediaApp: fan committed /media events into the
// app's Durable Object (guestbook shape — media volume doesn't warrant a
// wake-processor subscription), and on project/worker-updated mount the
// query surface at `itx.media` as a durable itx-call capability so agents
// answer "find my train ticket screenshot" with itx.media.search(...).
import type { DynamicWorkerCapability, ItxBinding, StreamEvent } from "../../sdk.ts";
import { mediaStreamPath, mediaWorkerRef } from "./app-ref.ts";
import type { MediaApp as MediaWorker } from "./worker.ts";

export const MediaApp = {
  create(env: { ITX: Pick<ItxBinding, "get"> }) {
    return {
      async processEvent(event: StreamEvent): Promise<void> {
        if (event.path === mediaStreamPath) {
          using project = await env.ITX.get();
          using worker = project.workers.get(mediaWorkerRef) as DynamicWorkerCapability<
            Pick<MediaWorker, "syncEvent">
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
            path: ["media"],
            expression: ["workers", ["get", mediaWorkerRef]],
            flattenNestedPaths: true,
            instructions:
              "Captured media (screenshots/photos) from the mobile app, searchable by content. " +
              "search({ q, tags?, limit? }) keyword-matches vision descriptions, OCR transcripts, " +
              "filenames, and tags, newest first, returning signed image URLs. " +
              "list({ limit? }) is the unfiltered newest; get(stableKey) one item.",
            types: [
              "type MediaSearchHit = { stableKey: string; path: string; filename: string;",
              "  contentType: string; width: number; height: number; source: string;",
              "  capturedAt: string | null; isScreenshot: boolean | null; capturedEventAt: string;",
              "  markdown: string; transcript: string; tags: string[]; processedBy: string;",
              "  url: string };",
              "type Media = {",
              "  search(query: { q?: string; tags?: string[]; limit?: number }): Promise<MediaSearchHit[]>;",
              "  list(query: { limit?: number }): Promise<MediaSearchHit[]>;",
              "  get(stableKey: string): Promise<Omit<MediaSearchHit, 'url'> | null>;",
              "};",
            ].join("\n"),
          });
        }
      },
    };
  },
};
