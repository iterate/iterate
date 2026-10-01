import { z } from "zod";

/** `events.iterate.com/itx/run-requested`: the whole script — the text of `async (itx) => …`.
 *  The event's own OFFSET is the run's identity: the settlement names it back. A caller's request
 *  starts at its commit; a processor's (the engine stamps `source.processor`) in the context's next
 *  alarm pass, a fresh invocation, so a processor's turns never pile up call depth. */
export const RunRequested = z.object({ code: z.string().min(1) });
export type RunRequested = z.infer<typeof RunRequested>;
/** How a failed run failed (`RunSettled` says what each kind means). */
const RunFailureKind = z.enum(["runtime", "deadline", "interrupted"]);
/** `events.iterate.com/itx/run-settled`: `requestOffset` names the request; `settlement` is
 *  what the script returned (JSON — a round trip drops what JSON cannot carry) or how it failed —
 *  `runtime` (the script threw, or returned what the log refuses), `deadline` (it had not finished
 *  when its time ran out; it may have partly run) or `interrupted` (the context restarted, or
 *  Cloudflare replaced its instance, before the run's settlement was written — it may have partly
 *  run — or before a processor's request started). A failed run is never run again. */
export const RunSettled = z.object({
  requestOffset: z.number().int().positive(),
  settlement: z.discriminatedUnion("status", [
    z.object({ status: z.literal("succeeded"), result: z.unknown().optional() }),
    z.object({ status: z.literal("failed"), error: z.string(), failureKind: RunFailureKind }),
  ]),
});
/** A failed run's error as its caller meets it: the settlement's `error` as the message, its
 *  `failureKind` on the error. */
export const RunFailure = z.object({ failureKind: RunFailureKind });
export type RunSettled = z.infer<typeof RunSettled>;
export type RunSettlement = RunSettled["settlement"];

/** THE RUN DEADLINE: ten minutes from the moment the context's runner starts a script. A run still
 *  going then is settled `failed` / `deadline` (core/os/src/library.ts), so a reader of the log
 *  counts a running script down to its request's time plus this. Ten minutes is what an agent's
 *  turn already allows: its model request expires after ten. */
export const RUN_DEADLINE_MS = 10 * 60_000;

/** The run events' catalog. The core owns them (core/os core-processor.ts); a processor that
 *  consumes them names this catalog in its `processorDeps`. */
export const RunEventCatalog = {
  events: {
    "events.iterate.com/itx/run-requested": {
      description:
        "A script this context is asked to run once, against its own itx, by whoever appended it (source.principal); the event's offset is the run.",
      payloadSchema: RunRequested,
    },
    "events.iterate.com/itx/run-settled": {
      description:
        "What the requested script returned, or how it failed; a run the context's restart interrupted is settled here too, never re-run.",
      payloadSchema: RunSettled,
    },
  },
};
