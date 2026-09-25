import { z } from "zod";

/** `events.iterate.com/itx/run-requested`: the whole script — the text of `async (itx) => …`.
 *  The event's own OFFSET is the run's identity: the settlement names it back. */
export const RunRequested = z.object({ code: z.string().min(1) });
export type RunRequested = z.infer<typeof RunRequested>;
/** `events.iterate.com/itx/run-settled`: `requestOffset` names the request; `settlement` is
 *  what the script returned (JSON — a round trip drops what JSON cannot carry) or how it failed —
 *  `runtime` (the script threw, or returned what the log refuses), `deadline` (it had not finished
 *  when its time ran out; it may have partly run) or `interrupted` (the context restarted before it
 *  finished). A failed run is never run again. */
export const RunSettled = z.object({
  requestOffset: z.number().int().positive(),
  settlement: z.discriminatedUnion("status", [
    z.object({ status: z.literal("succeeded"), result: z.unknown().optional() }),
    z.object({
      status: z.literal("failed"),
      error: z.string(),
      failureKind: z.enum(["runtime", "deadline", "interrupted"]),
    }),
  ]),
});
export type RunSettled = z.infer<typeof RunSettled>;
export type RunSettlement = RunSettled["settlement"];

/** Script lifecycle events available to userspace processors. */
export const RunContract = {
  slug: "context-runs",
  version: "1",
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
  initialState: () => ({}),
};
