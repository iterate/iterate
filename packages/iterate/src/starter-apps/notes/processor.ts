// The notes stream processor, convergence edition (tasks/mobile-notes.md
// grill session 2): a note IS a markdown file with frontmatter in the notes
// repo, and this processor owns the two side effects that make it more than
// a file — title/tags ANALYSIS written back into the file's frontmatter, and
// the git COMMIT lane that lands settled notes on the repo's main. It hosts
// on the notes workspace's own stream (/workspaces/notes), where writers
// append notes/* facts after their file writes (writeFile itself emits
// nothing durable). Invariant: nothing lives only in the stream — the fold
// holds obligations, never note content; files are truth.
import { z } from "zod";
import {
  defineProcessorContract,
  isIdempotencyConflict,
  StreamProcessor,
} from "../../processors/index.ts";
import type { ProcessEventArgs, ProcessorState, ReduceArgs } from "../../processors/index.ts";
import { composeNoteFile, noteDisplayTitle, parseNoteFile } from "./frontmatter.ts";
import { notesRepoPath } from "./ref.ts";

/** Analyzes note text into a title + tags; the model id lands in `processedBy`. */
export const NOTES_ANALYSIS_MODEL = "@cf/meta/llama-4-scout-17b-16e-instruct";

/** An obligation (including its settlement) is dead this long after the
 * capture/reanalyze event that opened it — a processor revived later settles
 * it as expired instead of titling a stale note. */
export const NOTES_ANALYSIS_EXPIRY_MS = 24 * 60 * 60 * 1000;

/** Quiet window between a settled fact and the git commit that sweeps every
 * dirty note in the mount — a burst of captures lands as one commit. */
export const NOTES_COMMIT_DEBOUNCE_MS = 10_000;

const AnalysisResult = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("succeeded"),
    title: z.string(),
    tags: z.array(z.string()),
    processedBy: z.string(),
  }),
  z.object({
    status: z.literal("superseded"),
    reason: z
      .string()
      .meta({ description: "Why nothing was written (file changed/gone/expired)." }),
  }),
  z.object({ status: z.literal("failed"), error: z.string() }),
]);

export const NotesProcessorContract = defineProcessorContract({
  slug: "notes",
  version: "0.2.0",
  description:
    "Hosts on the notes workspace stream; settles title/tags analysis into note-file frontmatter " +
    "and drives the settlement-debounced git commit lane. Files are truth; this fold holds only " +
    "open obligations.",
  stateSchema: z.object({
    pendingAnalyses: z
      .record(
        z.string(),
        z.object({
          path: z.string(),
          requestOffset: z.number(),
          expiresAtMs: z.number(),
        }),
      )
      .default({})
      .meta({
        description:
          "Open analysis obligations keyed `<path>:<requestOffset>` — opened by captured/updated/" +
          "reanalyze-requested (each supersedes the note's older obligations), closed by analysis-settled.",
      }),
  }),
  events: {
    "events.iterate.com/notes/captured": {
      description:
        "A note file entered the notes repo: the writer (phone composer, or any client) wrote " +
        "`<path>` through the notes workspace and appends this fact so the list updates live and " +
        "an analysis obligation opens. The file is the truth; this event carries only the address.",
      payloadSchema: z.object({ path: z.string() }),
      examples: [
        {
          description: "A capture from the phone composer.",
          payload: { path: "/repos/notes/2026-08-12T15-01-20-841Z-x7ab.md" },
        },
      ],
    },
    "events.iterate.com/notes/updated": {
      description:
        "The note file's body was edited (writer already rewrote the file). Supersedes the note's " +
        "open obligations and opens a fresh one, so a slow stale attempt can neither settle nor " +
        "write a title computed from the old text.",
      payloadSchema: z.object({ path: z.string() }),
      examples: [
        {
          description: "A typo fixed after capture.",
          payload: { path: "/repos/notes/2026-08-12T15-01-20-841Z-x7ab.md" },
        },
      ],
    },
    "events.iterate.com/notes/reanalyze-requested": {
      description: "Re-run title/tags analysis for one note (supersedes + reopens, like updated).",
      payloadSchema: z.object({ path: z.string() }),
      examples: [
        {
          description: "Re-analyze after a prompt improvement.",
          payload: { path: "/repos/notes/2026-08-12T15-01-20-841Z-x7ab.md" },
        },
      ],
    },
    "events.iterate.com/notes/analysis-settled": {
      description:
        "Terminal settlement of one analysis obligation. `succeeded` means the title/tags were " +
        "ALSO written into the file's frontmatter (the durable artifact); `superseded` means the " +
        "body changed or the file vanished before write-back; `failed` carries the error. Exactly " +
        "one per obligation, keyed on path + requestOffset.",
      payloadSchema: z.object({
        path: z.string(),
        requestOffset: z.number(),
        result: AnalysisResult,
      }),
      examples: [
        {
          description: "A successful analysis, frontmatter written.",
          payload: {
            path: "/repos/notes/2026-08-12T15-01-20-841Z-x7ab.md",
            requestOffset: 4,
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
        "The note file was deleted through the workspace (writer already called deleteFile). " +
        "Open obligations drop; the commit lane lands the git deletion.",
      payloadSchema: z.object({ path: z.string() }),
      examples: [
        {
          description: "A mistyped capture removed.",
          payload: { path: "/repos/notes/2026-08-12T15-01-20-841Z-x7ab.md" },
        },
      ],
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

/** The workspace slice the processor needs — injected so the harness fakes it
 * with an in-memory file map and the worker wires it over itx per call. */
export type NotesWorkspace = {
  readFile(path: string): Promise<string | null>;
  writeFile(path: string, content: string): Promise<void>;
  /** Paths dirty in the notes mount (relative to git truth). */
  dirtyNotePaths(): Promise<string[]>;
  commit(input: { message: string; scope: string }): Promise<void>;
};

type NotesProcessorDeps = {
  analyze: (input: { text: string }) => Promise<NotesAnalysis>;
  workspace: NotesWorkspace;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
};

export class NotesProcessor extends StreamProcessor<NotesProcessorContract, NotesProcessorDeps> {
  readonly contract = NotesProcessorContract;

  /** Runtime-only analysis attempts. The pendingAnalyses fold entries are the
   * durable truth: after an eviction this set is empty, and the next
   * caught-up pass safely restarts any still-open obligation. */
  readonly #liveAnalyses = new Set<string>();

  /** Runtime-only commit-lane latch — at most one debounce+commit attempt per
   * incarnation window. Recovery needs no evidence: every at-head pass
   * re-derives dirtiness from the workspace itself (git status), so a
   * dropped attempt is retried by the next batch or keepalive revival. */
  #commitInFlight = false;

  /** Opens (superseding) an analysis obligation for `path` at this event. */
  #reopen(state: NotesState, path: string, offset: number, createdAt: string): NotesState {
    return {
      pendingAnalyses: {
        // One open obligation per note: older ones are superseded so a slow
        // stale attempt's settlement folds to a no-op (unknown-obligation
        // guard) instead of racing this one for the frontmatter.
        ...Object.fromEntries(
          Object.entries(state.pendingAnalyses).filter(([, pending]) => pending.path !== path),
        ),
        [`${path}:${offset}`]: {
          path,
          requestOffset: offset,
          // Anchored to the event's own time, not the delivery clock — a
          // replayed frame must reduce to the same expiry.
          expiresAtMs: Date.parse(createdAt) + NOTES_ANALYSIS_EXPIRY_MS,
        },
      },
    };
  }

  protected override reduce({ event, state }: ReduceArgs<NotesProcessorContract>): NotesState {
    switch (event.type) {
      case "events.iterate.com/notes/captured":
      case "events.iterate.com/notes/updated":
      case "events.iterate.com/notes/reanalyze-requested":
        return this.#reopen(state, event.payload.path, event.offset, event.createdAt);
      case "events.iterate.com/notes/analysis-settled": {
        const obligationKey = `${event.payload.path}:${event.payload.requestOffset}`;
        // A settlement for an unknown obligation (already settled, or
        // superseded by a later capture/edit/delete) folds to a no-op.
        if (!state.pendingAnalyses[obligationKey]) return state;
        const { [obligationKey]: _settled, ...pendingAnalyses } = state.pendingAnalyses;
        return { pendingAnalyses };
      }
      case "events.iterate.com/notes/deleted":
        return {
          pendingAnalyses: Object.fromEntries(
            Object.entries(state.pendingAnalyses).filter(
              ([, pending]) => pending.path !== event.payload.path,
            ),
          ),
        };
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
              path: pending.path,
              requestOffset: pending.requestOffset,
              result: { status: "failed", error: "Analysis obligation expired before completion." },
            },
          }),
        );
        continue;
      }

      // Registered synchronously before any await so this same pass never
      // classifies its own attempt as undriven. A dropped attempt is
      // recovered from the still-open pendingAnalyses entry on the next
      // caught-up/revival pass (recovery = true on the hosting DO).
      this.#liveAnalyses.add(obligationKey);
      runInBackground(async () => {
        let result: z.infer<typeof AnalysisResult>;
        try {
          result = await this.#attemptAnalysis(pending.path);
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
            payload: { path: pending.path, requestOffset: pending.requestOffset, result },
          });
        } finally {
          this.#liveAnalyses.delete(obligationKey);
        }
      });
    }

    // The commit lane: after the debounce quiet window, sweep every dirty
    // note in the mount into one commit. A droppable attempt — recovery is
    // this very block on the next at-head pass (or keepalive revival):
    // dirtiness is re-derived from the workspace itself each time, and a
    // clean tree makes the attempt a no-op, so replays never re-commit.
    if (!this.#commitInFlight) {
      this.#commitInFlight = true;
      runInBackground(async () => {
        try {
          await this.deps.sleep(NOTES_COMMIT_DEBOUNCE_MS);
          const dirty = await this.deps.workspace.dirtyNotePaths();
          if (!dirty.length) return;
          await this.deps.workspace.commit({
            message: await this.#commitMessage(dirty),
            scope: notesRepoPath,
          });
        } finally {
          this.#commitInFlight = false;
        }
      });
    }
  }

  /** Read → analyze → re-read guard → frontmatter write-back. The write
   * composes from the RE-READ file, so foreign frontmatter keys and any
   * concurrent body edit are respected (body changed ⇒ superseded, nothing
   * written). Idempotent-by-overwrite on redelivery. */
  async #attemptAnalysis(path: string): Promise<z.infer<typeof AnalysisResult>> {
    const content = await this.deps.workspace.readFile(path);
    if (!content) {
      return { status: "superseded", reason: "note file no longer exists" };
    }
    const note = parseNoteFile(content);
    const analysis = await this.deps.analyze({ text: note.body });

    const current = await this.deps.workspace.readFile(path);
    if (!current) {
      return { status: "superseded", reason: "note file deleted during analysis" };
    }
    const currentNote = parseNoteFile(current);
    if (currentNote.body !== note.body) {
      return { status: "superseded", reason: "note body changed during analysis" };
    }
    await this.deps.workspace.writeFile(
      path,
      composeNoteFile(
        { ...currentNote.frontmatter, title: analysis.title, tags: analysis.tags },
        currentNote.body,
      ),
    );
    return { status: "succeeded", ...analysis };
  }

  /** "Standing desk height (+2 more)" — the first dirty note's display title
   * (or its filename stem when the file is a deletion), sized to a git
   * subject line. */
  async #commitMessage(dirtyPaths: string[]): Promise<string> {
    const [first] = dirtyPaths;
    const content = first ? await this.deps.workspace.readFile(first) : null;
    const stem = (first || "").split("/").at(-1)?.replace(/\.md$/, "") || "notes";
    const label = content ? noteDisplayTitle(parseNoteFile(content)) || stem : `remove ${stem}`;
    const rest = dirtyPaths.length - 1;
    return `notes: ${label}${rest > 0 ? ` (+${rest} more)` : ""}`.slice(0, 100);
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
