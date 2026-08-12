// The media stream processor: folds the mobile app's capture events on
// /media (vocab shared with apps/mobile/src/lib/media.ts) into a per-item
// map, latest processing winning — AND owns the server-side analysis
// reaction. A phone appends a cheap durable media/uploaded event right after
// the bytes land; this processor treats it as an open obligation, drives the
// vision pipeline (analysis.ts) via the injected `analyze` dep, and settles
// with ONE terminal media/processed event whose payload carries the result
// union (`error: null` on success). Obligation doctrine:
// docs/writing-stream-processors.md; GithubAiLinterProcessor is the sibling
// userland precedent. The MediaApp worker hosts this with `recovery = true`,
// so an eviction mid-analysis is revived by the keepalive and the caught-up
// pass restarts still-open obligations from reduced state.
import { z } from "zod";
import {
  defineProcessorContract,
  isIdempotencyConflict,
  StreamProcessor,
} from "../../processors/index.ts";
import type {
  EmittedInput,
  ProcessEventArgs,
  ProcessorState,
  ReduceArgs,
} from "../../processors/index.ts";
import type { MediaAnalysisResult } from "./analysis.ts";

/**
 * An analysis obligation is abandoned (settled as failed, without dialing
 * the AI) when its requesting event is older than this — the staleness
 * doctrine's horizon. Generous on purpose: a phone can upload while the
 * analyzer is broken and still get analyzed when the fix deploys; Re-analyze
 * covers anything older.
 */
export const MEDIA_ANALYSIS_EXPIRY_MS = 24 * 60 * 60 * 1000;

/** Tries per attempt, with backoff between them — covers the transient
 * Workers AI failure class ("8005: Internal server error") observed in prod
 * without an extra durable event per retry. */
const ANALYSIS_TRIES = 3;
const ANALYSIS_RETRY_BACKOFF_MS = [2_000, 8_000];

const processingFields = {
  title: z.string().default("").meta({
    description: "One-line description of what the image IS (pre-title events fold to empty).",
  }),
  markdown: z.string().meta({ description: "Vision-model description — half the search corpus." }),
  transcript: z.string().meta({ description: "Verbatim OCR of visible text — the other half." }),
  tags: z.array(z.string()).meta({ description: "Conservative multi-label tags." }),
  processedBy: z.string().meta({ description: "Model id that produced this processing." }),
};

const fileFields = {
  stableKey: z.string().meta({ description: "Content hash — the item's identity." }),
  path: z.string().meta({ description: "itx.files path holding the bytes." }),
  filename: z.string().meta({ description: "Original filename as picked/synced." }),
  contentType: z.string(),
  width: z.number(),
  height: z.number(),
  source: z.string().default("picker").meta({ description: '"picker" or "library-sync".' }),
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
};

const MediaItem = z.object({
  ...fileFields,
  capturedEventAt: z.string().meta({ description: "Stream time the capture committed." }),
  ...processingFields,
  analysisError: z
    .string()
    .nullable()
    .default(null)
    .meta({
      description:
        "The latest analysis settlement's failure, or null. Rows born from " +
        "media/uploaded exist regardless of analysis outcome; a terminal failure lands here.",
    }),
});

export type MediaItem = z.infer<typeof MediaItem>;

const PendingAnalysis = z.object({
  stableKey: z.string(),
  path: z.string(),
  filename: z.string(),
  contentType: z.string(),
  requestOffset: z.number().meta({
    description:
      "Offset of the uploaded/reanalyze event that opened this obligation — the " +
      "settlement's idempotency identity.",
  }),
  expiresAtMs: z.number().meta({
    description:
      "Epoch ms (request createdAt + MEDIA_ANALYSIS_EXPIRY_MS); past it the " +
      "obligation settles as expired without dialing the AI.",
  }),
});

type PendingAnalysis = z.infer<typeof PendingAnalysis>;

export const MediaProcessorContract = defineProcessorContract({
  slug: "media",
  version: "0.2.0",
  description:
    "Reduces captured media (screenshots/photos) on /media into a searchable index, and drives " +
    "server-side vision analysis of uploaded items (obligation pattern).",
  stateSchema: z.object({
    items: z
      .record(z.string(), MediaItem)
      .default({})
      .meta({ description: "Items by stableKey, latest processing overlaid." }),
    pendingAnalyses: z
      .record(z.string(), PendingAnalysis)
      .default({})
      .meta({
        description:
          "Open analysis obligations by stableKey (latest request wins); settled by one " +
          "media/processed event each.",
      }),
  }),
  events: {
    "events.iterate.com/media/uploaded": {
      description:
        "A media item's bytes landed in project files: the phone appends this cheap durable " +
        "fact right after files.put (metadata only — no analysis yet), idempotency-keyed by " +
        "content hash + wipe generation, sharing the media/captured key scheme so an item " +
        "already captured never re-uploads as a duplicate. Opens an analysis obligation.",
      payloadSchema: z.object(fileFields),
      examples: [
        {
          description: "A synced screenshot, uploaded and awaiting analysis.",
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
          },
        },
      ],
    },
    "events.iterate.com/media/reanalyze-requested": {
      description:
        "Re-analyze an existing item (the app's Re-analyze button): opens an analysis " +
        "obligation for it; the settlement overlays the item's processing fields.",
      payloadSchema: z.object({ stableKey: z.string() }),
      examples: [{ description: "A user-requested re-run.", payload: { stableKey: "abc123" } }],
    },
    "events.iterate.com/media/captured": {
      description:
        "LEGACY (pre media/uploaded): a media item entered the project with its first vision " +
        "processing inline, appended by the old phone-driven capture script. Still folded so " +
        "history keeps rendering; nothing appends it anymore.",
      payloadSchema: z.object({
        ...fileFields,
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
        "One analysis settlement (the obligation's single terminal event): on success the " +
        "processing fields overlay the item's, `error: null`; on terminal failure `error` says " +
        "why and the item's previous fields stay. Also appended by legacy phone-driven " +
        "re-analysis (no error/requestOffset).",
      payloadSchema: z.object({
        stableKey: z.string(),
        ...processingFields,
        error: z.string().nullable().default(null).meta({
          description: "Terminal analysis failure, or null on success.",
        }),
        requestOffset: z.number().nullable().default(null).meta({
          description: "The uploaded/reanalyze event this settles (null on legacy appends).",
        }),
      }),
      examples: [
        {
          description: "A successful server-side analysis of an uploaded item.",
          payload: {
            stableKey: "abc123",
            title: "Trenitalia ticket Rome→Florence 09:45",
            markdown: "A train ticket from Rome to Florence.",
            transcript: "Trenitalia 09:45",
            tags: ["screenshot", "logistics"],
            processedBy: "@cf/meta/llama-4-scout-17b-16e-instruct",
            error: null,
            requestOffset: 12,
          },
        },
      ],
    },
  },
  consumes: [
    "events.iterate.com/media/uploaded",
    "events.iterate.com/media/reanalyze-requested",
    "events.iterate.com/media/captured",
    "events.iterate.com/media/processed",
    "events.iterate.com/media/wiped",
  ],
  emits: ["events.iterate.com/media/processed"],
});
export type MediaProcessorContract = typeof MediaProcessorContract;

export type MediaState = ProcessorState<MediaProcessorContract>;

type MediaProcessorDeps = {
  /** The vision pipeline (analysis.ts), injected so tests run in plain node. */
  analyze: (input: {
    path: string;
    filename: string;
    contentType: string;
  }) => Promise<MediaAnalysisResult>;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
};

export class MediaProcessor extends StreamProcessor<MediaProcessorContract, MediaProcessorDeps> {
  readonly contract = MediaProcessorContract;

  /**
   * Runtime-only attempts by stableKey. The uploaded/reanalyze +
   * processed events are the durable truth: after an eviction this set is
   * empty and the next caught-up pass restarts any still-open obligation.
   */
  readonly #liveAnalyses = new Set<string>();

  protected override reduce({ event, state }: ReduceArgs<MediaProcessorContract>) {
    switch (event.type) {
      case "events.iterate.com/media/uploaded": {
        // A stableKey already present (legacy captured, or a duplicate
        // upload racing the phone's getEvent check) folds to a no-op — no
        // duplicate row, no redundant analysis.
        if (state.items[event.payload.stableKey] !== undefined) return state;
        return {
          ...state,
          items: {
            ...state.items,
            [event.payload.stableKey]: {
              ...event.payload,
              capturedEventAt: event.createdAt,
              title: "",
              markdown: "",
              transcript: "",
              tags: [],
              processedBy: "",
              analysisError: null,
            },
          },
          pendingAnalyses: {
            ...state.pendingAnalyses,
            [event.payload.stableKey]: pendingAnalysisFor(event),
          },
        };
      }
      case "events.iterate.com/media/reanalyze-requested": {
        const item = state.items[event.payload.stableKey];
        // Nothing to re-analyze for an unknown item — skip rather than
        // invent an obligation with no file behind it.
        if (item === undefined) return state;
        return {
          ...state,
          pendingAnalyses: {
            ...state.pendingAnalyses,
            // Latest request wins: a reanalyze during a pending initial
            // analysis collapses to one obligation (one settlement key).
            [item.stableKey]: {
              stableKey: item.stableKey,
              path: item.path,
              filename: item.filename,
              contentType: item.contentType,
              requestOffset: event.offset,
              expiresAtMs: Date.parse(event.createdAt) + MEDIA_ANALYSIS_EXPIRY_MS,
            },
          },
        };
      }
      case "events.iterate.com/media/captured": {
        // Idempotency-keyed at the source; a duplicate folds to a no-op.
        if (state.items[event.payload.stableKey] !== undefined) return state;
        return {
          ...state,
          items: {
            ...state.items,
            [event.payload.stableKey]: {
              ...event.payload,
              capturedEventAt: event.createdAt,
              analysisError: null,
            },
          },
        };
      }
      case "events.iterate.com/media/wiped":
        return { ...state, items: {}, pendingAnalyses: {} };
      case "events.iterate.com/media/processed": {
        const { [event.payload.stableKey]: _settled, ...pendingAnalyses } = state.pendingAnalyses;
        const existing = state.items[event.payload.stableKey];
        // A processed event for an unknown item (e.g. pre-rename history)
        // has nothing to overlay — skip rather than invent a partial item.
        if (existing === undefined) return { ...state, pendingAnalyses };
        // `||` folds legacy payloads (no error field, reduced without the
        // contract parse in old states) into the success arm.
        const error = event.payload.error || null;
        const item =
          error === null
            ? {
                ...existing,
                title: event.payload.title,
                markdown: event.payload.markdown,
                transcript: event.payload.transcript,
                tags: event.payload.tags,
                processedBy: event.payload.processedBy,
                analysisError: null,
              }
            : // A failed analysis keeps whatever the item already shows; the
              // failure itself becomes visible on the row.
              { ...existing, analysisError: error };
        return {
          ...state,
          items: { ...state.items, [event.payload.stableKey]: item },
          pendingAnalyses,
        };
      }
      default:
        return state;
    }
  }

  protected override processEvent(args: ProcessEventArgs<MediaProcessorContract>): undefined {
    // Behind head, a settlement may already sit in an unseen page — acting
    // early would re-run a settled analysis.
    if (!args.delivery.caughtUp) return;
    const now = this.deps.now();
    const expired: PendingAnalysis[] = [];
    for (const pending of Object.values(args.state.pendingAnalyses)) {
      if (this.#liveAnalyses.has(pending.stableKey)) continue;
      if (now >= pending.expiresAtMs) {
        expired.push(pending);
        continue;
      }
      // Registered synchronously before any await so this same pass never
      // classifies its own attempt as undriven.
      this.#liveAnalyses.add(pending.stableKey);
      // A dropped attempt is recovered from the still-open obligation on the
      // next caught-up/revival pass (the worker hosts this with recovery on).
      args.runInBackground(async () => {
        try {
          const settlement = await this.#attemptAnalysis(pending);
          await this.#appendSettlement(args.append, pending, settlement);
        } finally {
          this.#liveAnalyses.delete(pending.stableKey);
        }
      });
    }
    if (expired.length === 0) return;
    // Short must-happen appends: an expired obligation's settlement must
    // land even if this incarnation dies right after the pass — otherwise
    // the row shows "Analyzing…" forever.
    args.blockProcessorWhile(async () => {
      for (const pending of expired) {
        await this.#appendSettlement(args.append, pending, {
          error:
            "analysis window expired before it could run " +
            `(older than ${MEDIA_ANALYSIS_EXPIRY_MS / 3_600_000}h) — use Re-analyze to retry`,
        });
      }
    });
  }

  /** One attempt = up to {@link ANALYSIS_TRIES} tries with short backoff. */
  async #attemptAnalysis(
    pending: PendingAnalysis,
  ): Promise<{ result: MediaAnalysisResult } | { error: string }> {
    let lastError = "analysis failed";
    for (let tryIndex = 0; tryIndex < ANALYSIS_TRIES; tryIndex++) {
      if (tryIndex > 0) {
        await this.deps.sleep(
          ANALYSIS_RETRY_BACKOFF_MS[Math.min(tryIndex - 1, ANALYSIS_RETRY_BACKOFF_MS.length - 1)]!,
        );
      }
      try {
        return { result: await this.deps.analyze(pending) };
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
    }
    return { error: lastError.slice(0, 2_000) };
  }

  /**
   * The obligation's single terminal event. The key is state-derived and
   * deterministic per obligation (`@<stableKey>:<requestOffset>`); bodies
   * contain AI output, so two racing incarnations can collide
   * same-key/different-body — the first committed settlement is the
   * authority and the loser tolerates the conflict (ai-linter shape).
   */
  async #appendSettlement(
    append: ProcessEventArgs<MediaProcessorContract>["append"],
    pending: PendingAnalysis,
    outcome: { result: MediaAnalysisResult } | { error: string },
  ): Promise<void> {
    const event: EmittedInput<MediaProcessorContract> = {
      type: "events.iterate.com/media/processed",
      idempotencyKey: this.idempotencyKey(
        `analysis-settled@${pending.stableKey}:${pending.requestOffset}`,
      ),
      payload: {
        stableKey: pending.stableKey,
        requestOffset: pending.requestOffset,
        ...("result" in outcome
          ? { ...outcome.result, error: null }
          : {
              title: "",
              markdown: "",
              transcript: "",
              tags: [],
              processedBy: "",
              error: outcome.error,
            }),
      },
    };
    try {
      await append(event);
    } catch (error) {
      if (!isIdempotencyConflict(error)) throw error;
    }
  }
}

function pendingAnalysisFor(event: {
  createdAt: string;
  offset: number;
  payload: { stableKey: string; path: string; filename: string; contentType: string };
}): PendingAnalysis {
  return {
    stableKey: event.payload.stableKey,
    path: event.payload.path,
    filename: event.payload.filename,
    contentType: event.payload.contentType,
    requestOffset: event.offset,
    expiresAtMs: Date.parse(event.createdAt) + MEDIA_ANALYSIS_EXPIRY_MS,
  };
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
