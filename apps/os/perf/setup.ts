// perf/setup.ts — what a perf row that FAILED leaves on its meta beside the failure message, the one
// thing Vitest's JSON report keeps of an error (perf/record.ts `failure`): the code of every cause
// behind its errors, and every session socket it lost with no Close frame. The latency guard
// (scripts/ci/os-latency-guard.ts) records both with a probe the platform broke; without them the
// report says `TypeError: fetch failed` and never `read ECONNRESET` (main 927f7a835, 2026-09-24),
// and the lost sockets' timings are only in the job's log.

import { afterEach } from "vitest";
import { z } from "zod";
import { socketsLost } from "../e2e/support/client.ts";

afterEach(({ task }) => {
  if (task.result?.state !== "fail") return;
  task.meta.failure = {
    causes: (task.result.errors || []).flatMap((error) => causesOf(error)),
    socketsLost: socketsLost(),
  };
});

/** An error's `cause` as Vitest serializes it: a Node system error or undici's carries a `code`. */
const Cause = z.object({
  code: z.string().optional(),
  message: z.string().optional(),
  cause: z.unknown().optional(),
});

/** The code (or, with none, the message) of each cause behind `error`, outermost first. */
function causesOf(error: unknown): string[] {
  const cause = Cause.safeParse(
    z.object({ cause: z.unknown().optional() }).safeParse(error).data?.cause,
  );
  if (!cause.success) return [];
  return [cause.data.code || cause.data.message || "a cause with no code", ...causesOf(cause.data)];
}
