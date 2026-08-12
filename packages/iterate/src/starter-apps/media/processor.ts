// The media stream processor: folds the mobile app's capture pipeline events
// (events.iterate.com/media/captured + media/processed on /media — vocab
// defined by apps/mobile/src/lib/media.ts) into a per-item map, latest
// processing winning. Pure fold, no side effects; the MediaApp worker layers
// search/list/get on the reduced state.
import { z } from "zod";
import { defineProcessorContract, StreamProcessor } from "../../processors/index.ts";
import type { ProcessorState, ReduceArgs } from "../../processors/index.ts";

const processingFields = {
  title: z.string().default("").meta({
    description: "One-line description of what the image IS (pre-title events fold to empty).",
  }),
  markdown: z.string().meta({ description: "Vision-model description — half the search corpus." }),
  transcript: z.string().meta({ description: "Verbatim OCR of visible text — the other half." }),
  tags: z.array(z.string()).meta({ description: "Conservative multi-label tags." }),
  processedBy: z.string().meta({ description: "Model id that produced this processing." }),
};

const MediaItem = z.object({
  stableKey: z.string().meta({ description: "Content hash — the item's identity." }),
  path: z.string().meta({ description: "itx.files path holding the bytes." }),
  filename: z.string().meta({ description: "Original filename as picked/synced." }),
  contentType: z.string(),
  width: z.number(),
  height: z.number(),
  source: z
    .string()
    .default("picker")
    .meta({ description: '"picker", "library-sync", or "note" (a note attachment).' }),
  capturedAt: z
    .string()
    .nullable()
    .default(null)
    .meta({ description: "Asset creation time (ISO) when the source knew it." }),
  isScreenshot: z
    .boolean()
    .nullable()
    .default(null)
    .meta({ description: "iOS mediaSubtypes screenshot flag." }),
  capturedEventAt: z.string().meta({ description: "Stream time the capture committed." }),
  ...processingFields,
});

export type MediaItem = z.infer<typeof MediaItem>;

export const MediaProcessorContract = defineProcessorContract({
  slug: "media",
  version: "0.1.0",
  description: "Reduces captured media (screenshots/photos) on /media into a searchable index.",
  stateSchema: z.object({
    items: z
      .record(z.string(), MediaItem)
      .default({})
      .meta({ description: "Items by stableKey, latest processing overlaid." }),
  }),
  events: {
    "events.iterate.com/media/captured": {
      description:
        "A media item entered the project: bytes stored, first vision processing inline. " +
        "Appended by the capture pipeline script, idempotency-keyed by content hash.",
      payloadSchema: z.object({
        stableKey: z.string(),
        path: z.string(),
        filename: z.string(),
        contentType: z.string(),
        width: z.number(),
        height: z.number(),
        source: z.string().default("picker"),
        capturedAt: z.string().nullable().default(null),
        isScreenshot: z.boolean().nullable().default(null),
        ...processingFields,
      }),
      examples: [
        {
          description: "A synced screenshot with its first processing.",
          payload: {
            stableKey: "abc123",
            path: "/media/abc123-IMG_0001.png",
            filename: "IMG_0001.png",
            contentType: "image/png",
            width: 1170,
            height: 2532,
            source: "library-sync",
            capturedAt: "2026-08-10T09:00:00.000Z",
            isScreenshot: true,
            markdown: "A train ticket from Rome to Florence.",
            transcript: "Trenitalia 09:45",
            tags: ["screenshot", "logistics"],
            processedBy: "@cf/meta/llama-4-scout-17b-16e-instruct",
          },
        },
      ],
    },
    "events.iterate.com/media/wiped": {
      description:
        "Everything before this tombstone is gone: the wipe script deleted the stored files and " +
        "every derivation (phone list, this fold) resets. Deliberate per-invocation idempotency key.",
      payloadSchema: z.object({
        deletedFiles: z.number().meta({ description: "Files actually deleted." }),
        items: z.number().meta({ description: "Items that existed at wipe time." }),
      }),
      examples: [
        { description: "A from-scratch reset.", payload: { deletedFiles: 24, items: 24 } },
      ],
    },
    "events.iterate.com/media/processed": {
      description:
        "A re-analysis of an existing item (Re-analyze in the app, or batch re-tagging): " +
        "the latest one supersedes the item's processing fields.",
      payloadSchema: z.object({
        stableKey: z.string(),
        ...processingFields,
      }),
      examples: [
        {
          description: "A re-tag after a taxonomy improvement.",
          payload: {
            stableKey: "abc123",
            markdown: "A train ticket from Rome to Florence.",
            transcript: "Trenitalia 09:45",
            tags: ["screenshot", "logistics", "receipt"],
            processedBy: "@cf/meta/llama-4-scout-17b-16e-instruct",
          },
        },
      ],
    },
  },
  consumes: [
    "events.iterate.com/media/captured",
    "events.iterate.com/media/processed",
    "events.iterate.com/media/wiped",
  ],
  emits: [],
});
export type MediaProcessorContract = typeof MediaProcessorContract;

export type MediaState = ProcessorState<MediaProcessorContract>;

export class MediaProcessor extends StreamProcessor<MediaProcessorContract> {
  readonly contract = MediaProcessorContract;

  protected override reduce({ event, state }: ReduceArgs<MediaProcessorContract>) {
    switch (event.type) {
      case "events.iterate.com/media/captured": {
        // Idempotency-keyed at the source; a duplicate folds to a no-op.
        if (state.items[event.payload.stableKey] !== undefined) return state;
        return {
          ...state,
          items: {
            ...state.items,
            [event.payload.stableKey]: { ...event.payload, capturedEventAt: event.createdAt },
          },
        };
      }
      case "events.iterate.com/media/wiped":
        return { ...state, items: {} };
      case "events.iterate.com/media/processed": {
        const existing = state.items[event.payload.stableKey];
        // A processed event for an unknown item (e.g. pre-rename history)
        // has nothing to overlay — skip rather than invent a partial item.
        if (existing === undefined) return state;
        return {
          ...state,
          items: { ...state.items, [event.payload.stableKey]: { ...existing, ...event.payload } },
        };
      }
      default:
        return state;
    }
  }
}

/**
 * Search semantics shared with the phone's client-side filter
 * (apps/mobile/src/lib/media.ts filterMedia — kept in sync by hand, the two
 * runtimes can't share a module yet): every whitespace-separated term must
 * appear in description, transcript, filename, stored name, or tags; every
 * selected tag must be present. Newest first.
 */
export function searchMediaItems(
  state: MediaState,
  query: { q?: string; tags?: string[]; limit?: number },
): MediaItem[] {
  const terms = (query.q || "").toLowerCase().split(/\s+/).filter(Boolean);
  const requiredTags = query.tags || [];
  return Object.values(state.items)
    .filter((item) => {
      const storedName = (item.path.split("/").at(-1) || "").replace(/^[0-9a-f]{32,}-/, "");
      const haystack =
        `${item.title} ${item.markdown} ${item.transcript} ${item.filename} ${storedName} ${item.tags.join(" ")}`.toLowerCase();
      return (
        terms.every((term) => haystack.includes(term)) &&
        requiredTags.every((tag) => item.tags.includes(tag))
      );
    })
    .sort((a, b) =>
      (b.capturedAt || b.capturedEventAt).localeCompare(a.capturedAt || a.capturedEventAt),
    )
    .slice(0, query.limit || 20);
}
