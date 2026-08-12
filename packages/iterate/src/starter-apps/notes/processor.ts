// The notes stream processor: folds the mobile app's note-capture events
// (events.iterate.com/notes/* on /notes — the phone's vocabulary lives in
// apps/mobile/src/lib/notes.ts) into a per-note map, and owns the ONE side
// effect of the domain: title/tags analysis of a note's text, run as an
// obligation (docs/writing-stream-processors.md). Capture stays instant and
// dumb — the phone appends notes/captured with no AI in the path; this
// processor notices the open obligation at head and settles it with exactly
// one notes/analysis-settled event.
import { z } from "zod";
import {
  defineProcessorContract,
  isIdempotencyConflict,
  StreamProcessor,
} from "../../processors/index.ts";
import type { ProcessEventArgs, ProcessorState, ReduceArgs } from "../../processors/index.ts";

/** Analyzes note text into a title + tags; the model id lands in `processedBy`. */
export const NOTES_ANALYSIS_MODEL = "@cf/meta/llama-4-scout-17b-16e-instruct";

/** An obligation (including its settlement) is dead this long after the
 * capture/reanalyze event that opened it — a processor revived later settles
 * it as expired instead of titling a stale note. */
export const NOTES_ANALYSIS_EXPIRY_MS = 24 * 60 * 60 * 1000;

const NoteAttachment = z.object({
  path: z.string().meta({ description: "itx.files path holding the bytes (mediaFilePath shape)." }),
  filename: z.string(),
  contentType: z.string(),
  width: z.number(),
  height: z.number(),
});

const analysisFields = {
  title: z.string().default("").meta({
    description: "One-line derived title; the phone falls back to the text's first line.",
  }),
  tags: z.array(z.string()).default([]),
  processedBy: z.string().default("").meta({ description: "Model id that produced the analysis." }),
};

const NoteItem = z.object({
  noteKey: z.string().meta({ description: "Client-minted unique id — the note's identity." }),
  text: z.string(),
  attachments: z.array(NoteAttachment).default([]),
  capturedOnDeviceAt: z.string().nullable().default(null).meta({
    description: "When the note was typed (ISO) — predates append for drained pending notes.",
  }),
  capturedEventAt: z.string().meta({ description: "Stream time the capture committed." }),
  offset: z.number().meta({ description: "The captured event's offset — list ordering identity." }),
  analysisError: z.string().default("").meta({ description: "Latest failed analysis, if any." }),
  ...analysisFields,
});

export type NoteItem = z.infer<typeof NoteItem>;

const AnalysisResult = z.discriminatedUnion("status", [
  z.object({ status: z.literal("succeeded"), ...analysisFields }),
  z.object({ status: z.literal("failed"), error: z.string() }),
]);

export const NotesProcessorContract = defineProcessorContract({
  slug: "notes",
  version: "0.1.0",
  description:
    "Reduces captured notes on /notes into a searchable index and settles title/tags analysis obligations.",
  stateSchema: z.object({
    notes: z
      .record(z.string(), NoteItem)
      .default({})
      .meta({ description: "Live notes by noteKey; deleted notes are removed." }),
    pendingAnalyses: z
      .record(
        z.string(),
        z.object({
          noteKey: z.string(),
          requestOffset: z.number(),
          expiresAtMs: z.number(),
        }),
      )
      .default({})
      .meta({
        description:
          "Open analysis obligations keyed `<noteKey>:<requestOffset>` — opened by captured/reanalyze-requested, closed by analysis-settled.",
      }),
  }),
  events: {
    "events.iterate.com/notes/captured": {
      description:
        "A note entered the project: text (plus optional photo attachment refs) captured on the " +
        "phone. Appended by the mobile composer, idempotency-keyed by the client-minted noteKey. " +
        "Opens a title/tags analysis obligation.",
      payloadSchema: z.object({
        noteKey: z.string(),
        text: z.string(),
        attachments: z.array(NoteAttachment).default([]),
        capturedOnDeviceAt: z.string().nullable().default(null),
      }),
      examples: [
        {
          description: "A plain text note.",
          payload: {
            noteKey: "m1abc-x7",
            text: "Standing desk height: 76cm was right at the office",
            attachments: [],
            capturedOnDeviceAt: "2026-08-12T09:00:00.000Z",
          },
        },
      ],
    },
    "events.iterate.com/notes/updated": {
      description:
        "The note's text was edited. Supersedes prior analysis: derived title/tags reset to the " +
        "first-line fallback and a fresh obligation opens (any still-open older obligation for " +
        "the note is dropped, so a slow stale attempt cannot overlay a title computed from the " +
        "old text).",
      payloadSchema: z.object({ noteKey: z.string(), text: z.string() }),
      examples: [
        {
          description: "A typo fixed after capture.",
          payload: { noteKey: "m1abc-x7", text: "Standing desk height: 76cm (not 67!)" },
        },
      ],
    },
    "events.iterate.com/notes/reanalyze-requested": {
      description: "Re-run title/tags analysis for one note (opens a fresh obligation).",
      payloadSchema: z.object({ noteKey: z.string() }),
      examples: [
        { description: "Re-analyze after a prompt improvement.", payload: { noteKey: "m1abc-x7" } },
      ],
    },
    "events.iterate.com/notes/analysis-settled": {
      description:
        "Terminal settlement of one analysis obligation — success carries the title/tags, " +
        "failure the error. Exactly one per obligation, keyed on noteKey + requestOffset.",
      payloadSchema: z.object({
        noteKey: z.string(),
        requestOffset: z.number(),
        result: AnalysisResult,
      }),
      examples: [
        {
          description: "A successful analysis.",
          payload: {
            noteKey: "m1abc-x7",
            requestOffset: 1,
            result: {
              status: "succeeded",
              title: "Standing desk height",
              tags: ["reference"],
              processedBy: NOTES_ANALYSIS_MODEL,
            },
          },
        },
      ],
    },
    "events.iterate.com/notes/deleted": {
      description:
        "Tombstone: the note is gone from every derivation (phone list, this fold) and its open " +
        "obligations are dropped. Attachment files are not deleted (they may be shared with /media).",
      payloadSchema: z.object({ noteKey: z.string() }),
      examples: [{ description: "A mistyped capture removed.", payload: { noteKey: "m1abc-x7" } }],
    },
  },
  consumes: [
    "events.iterate.com/notes/captured",
    "events.iterate.com/notes/updated",
    "events.iterate.com/notes/reanalyze-requested",
    "events.iterate.com/notes/analysis-settled",
    "events.iterate.com/notes/deleted",
  ],
  emits: ["events.iterate.com/notes/analysis-settled"],
});
export type NotesProcessorContract = typeof NotesProcessorContract;

export type NotesState = ProcessorState<NotesProcessorContract>;

export type NotesAnalysis = { title: string; tags: string[]; processedBy: string };

type NotesProcessorDeps = {
  /** Text → title/tags. Injected so the harness can fake it; the worker wires
   * it to one itx ai.run call (analysis.ts). */
  analyze: (input: { text: string }) => Promise<NotesAnalysis>;
  now: () => number;
};

export class NotesProcessor extends StreamProcessor<NotesProcessorContract, NotesProcessorDeps> {
  readonly contract = NotesProcessorContract;

  /** Runtime-only analysis attempts. The pendingAnalyses fold entries are the
   * durable truth: after an eviction this set is empty, and the next
   * caught-up pass safely restarts any still-open obligation. */
  readonly #liveAnalyses = new Set<string>();

  protected override reduce({ event, state }: ReduceArgs<NotesProcessorContract>): NotesState {
    switch (event.type) {
      case "events.iterate.com/notes/captured": {
        // Idempotency-keyed at the source; a duplicate folds to a no-op.
        if (state.notes[event.payload.noteKey] !== undefined) return state;
        return {
          notes: {
            ...state.notes,
            [event.payload.noteKey]: {
              ...event.payload,
              capturedEventAt: event.createdAt,
              offset: event.offset,
              title: "",
              tags: [],
              processedBy: "",
              analysisError: "",
            },
          },
          pendingAnalyses: {
            ...state.pendingAnalyses,
            [`${event.payload.noteKey}:${event.offset}`]: {
              noteKey: event.payload.noteKey,
              requestOffset: event.offset,
              // Anchored to the event's own time, not the delivery clock —
              // a replayed frame must reduce to the same expiry.
              expiresAtMs: Date.parse(event.createdAt) + NOTES_ANALYSIS_EXPIRY_MS,
            },
          },
        };
      }
      case "events.iterate.com/notes/updated": {
        const note = state.notes[event.payload.noteKey];
        if (note === undefined) return state;
        return {
          notes: {
            ...state.notes,
            [event.payload.noteKey]: {
              ...note,
              text: event.payload.text,
              // Derived garnish resets with the text it derived from; the
              // fresh obligation below re-earns it.
              title: "",
              tags: [],
              processedBy: "",
              analysisError: "",
            },
          },
          pendingAnalyses: {
            // Older obligations for this note are superseded: dropping them
            // makes a slow stale attempt's settlement fold to a no-op (the
            // settled arm's unknown-obligation guard) instead of overlaying
            // a title computed from the pre-edit text.
            ...Object.fromEntries(
              Object.entries(state.pendingAnalyses).filter(
                ([, pending]) => pending.noteKey !== event.payload.noteKey,
              ),
            ),
            [`${event.payload.noteKey}:${event.offset}`]: {
              noteKey: event.payload.noteKey,
              requestOffset: event.offset,
              expiresAtMs: Date.parse(event.createdAt) + NOTES_ANALYSIS_EXPIRY_MS,
            },
          },
        };
      }
      case "events.iterate.com/notes/reanalyze-requested": {
        if (state.notes[event.payload.noteKey] === undefined) return state;
        return {
          ...state,
          pendingAnalyses: {
            // Same supersession as `updated`: one open obligation per note.
            // A still-open older obligation (e.g. a hung attempt) is dropped
            // so its late settlement folds to a no-op instead of racing the
            // re-run's result for the overlay.
            ...Object.fromEntries(
              Object.entries(state.pendingAnalyses).filter(
                ([, pending]) => pending.noteKey !== event.payload.noteKey,
              ),
            ),
            [`${event.payload.noteKey}:${event.offset}`]: {
              noteKey: event.payload.noteKey,
              requestOffset: event.offset,
              expiresAtMs: Date.parse(event.createdAt) + NOTES_ANALYSIS_EXPIRY_MS,
            },
          },
        };
      }
      case "events.iterate.com/notes/analysis-settled": {
        const obligationKey = `${event.payload.noteKey}:${event.payload.requestOffset}`;
        // A settlement for an unknown obligation (already settled, or dropped
        // by a delete) overlays nothing — skip rather than resurrect.
        if (state.pendingAnalyses[obligationKey] === undefined) return state;
        const { [obligationKey]: _settled, ...pendingAnalyses } = state.pendingAnalyses;
        const note = state.notes[event.payload.noteKey];
        if (note === undefined) return { ...state, pendingAnalyses };
        const result = event.payload.result;
        return {
          notes: {
            ...state.notes,
            [event.payload.noteKey]:
              result.status === "succeeded"
                ? {
                    ...note,
                    title: result.title,
                    tags: result.tags,
                    processedBy: result.processedBy,
                    analysisError: "",
                  }
                : { ...note, analysisError: result.error },
          },
          pendingAnalyses,
        };
      }
      case "events.iterate.com/notes/deleted": {
        const { [event.payload.noteKey]: _deleted, ...notes } = state.notes;
        return {
          notes,
          pendingAnalyses: Object.fromEntries(
            Object.entries(state.pendingAnalyses).filter(
              ([, pending]) => pending.noteKey !== event.payload.noteKey,
            ),
          ),
        };
      }
      default:
        return state;
    }
  }

  protected override processEvent(args: ProcessEventArgs<NotesProcessorContract>): undefined {
    const { append, blockProcessorWhile, delivery, runInBackground, state } = args;
    // Behind head, a settlement may already sit in an unseen page — starting
    // an analysis from partial state would double-run it.
    if (!delivery.caughtUp) return;

    for (const [obligationKey, pending] of Object.entries(state.pendingAnalyses)) {
      if (this.#liveAnalyses.has(obligationKey)) continue;
      const settlementKey = this.idempotencyKey(`analysis-settled@${obligationKey}`);

      if (this.deps.now() > pending.expiresAtMs) {
        // Short must-land append: without it a revival long after the capture
        // would re-attempt a stale analysis forever. Held so redelivery
        // retries it if this frame drops.
        blockProcessorWhile(() =>
          this.#appendUnlessLostSettlementRace(append, {
            type: "events.iterate.com/notes/analysis-settled",
            idempotencyKey: settlementKey,
            payload: {
              noteKey: pending.noteKey,
              requestOffset: pending.requestOffset,
              result: { status: "failed", error: "Analysis obligation expired before completion." },
            },
          }),
        );
        continue;
      }

      const note = state.notes[pending.noteKey];
      if (note === undefined) continue;

      // Registered synchronously before any await so this same pass never
      // classifies its own attempt as undriven. A dropped attempt is
      // recovered from the still-open pendingAnalyses entry on the next
      // caught-up/revival pass (recovery = true on the hosting DO).
      this.#liveAnalyses.add(obligationKey);
      runInBackground(async () => {
        let result: z.infer<typeof AnalysisResult>;
        try {
          result = { status: "succeeded", ...(await this.deps.analyze({ text: note.text })) };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          result = {
            status: "failed",
            error: message.slice(0, 8_000) || "Unknown analysis failure.",
          };
        }
        try {
          await this.#appendUnlessLostSettlementRace(append, {
            type: "events.iterate.com/notes/analysis-settled",
            idempotencyKey: settlementKey,
            payload: { noteKey: pending.noteKey, requestOffset: pending.requestOffset, result },
          });
        } finally {
          this.#liveAnalyses.delete(obligationKey);
        }
      });
    }
  }

  /** Overlapping attempts (a zombie incarnation, an expiry racing a late
   * success) share one terminal key; the first committed settlement is the
   * authority, so a same-key/different-body rejection means "already
   * settled", not "wedge the frame". */
  async #appendUnlessLostSettlementRace(
    append: ProcessEventArgs<NotesProcessorContract>["append"],
    event: Parameters<ProcessEventArgs<NotesProcessorContract>["append"]>[0],
  ): Promise<void> {
    try {
      await append(event);
    } catch (error) {
      if (!isIdempotencyConflict(error)) throw error;
    }
  }
}

/**
 * Search semantics shared with the phone's client-side filter
 * (apps/mobile/src/lib/notes.ts filterNotes — kept in sync by hand, the two
 * runtimes can't share a module yet): every whitespace-separated term must
 * appear in title, text, attachment filenames, or tags. Newest first.
 */
export function searchNotes(state: NotesState, query: { q?: string; limit?: number }): NoteItem[] {
  const terms = (query.q || "").toLowerCase().split(/\s+/).filter(Boolean);
  return Object.values(state.notes)
    .filter((note) => {
      const haystack =
        `${note.title} ${note.text} ${note.attachments.map((a) => a.filename).join(" ")} ${note.tags.join(" ")}`.toLowerCase();
      return terms.every((term) => haystack.includes(term));
    })
    .sort((a, b) => b.offset - a.offset)
    .slice(0, query.limit || 20);
}
