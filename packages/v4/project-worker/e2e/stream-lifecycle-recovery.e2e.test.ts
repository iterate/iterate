// stream-lifecycle-recovery.e2e.test.ts — DEPLOYED acceptance for one explicitly-classified
// Durable Object lifecycle interruption. This is deliberately separate from stream-memory-budget:
// that original no-retry diagnostic remains untouched. The one recovery here applies only to a
// physical page read or the known idempotent user-tally snapshot, never to seed writes, enablement,
// arbitrary facets, or a general client API.

import { beforeAll, expect, test } from "vitest";
import { append, disposeSessions, freshCtx, openItx, sleep } from "./support/client.ts";
import { enableFixtureProcessor } from "./support/sources.ts";

const MiB = 1024 * 1024;
const EVENT_COUNT = 24;
const EVENT_CHARS = 6 * MiB;
const blobFor = (n: number): string => String.fromCharCode(97 + (n % 26)).repeat(EVENT_CHARS);
const deployed = test.skipIf(!process.env.WORKER_BASE_URL);

let context: string;
let seededOffsets: number[] = [];

type RuntimeFlags = {
  retryable: boolean | undefined;
  durableObjectReset: boolean | undefined;
  overloaded: boolean | undefined;
};

type LifecycleResetInspection = {
  flags: RuntimeFlags;
  retryableLifecycleReset: boolean;
};

/** Read platform flags exactly once. Only the canonical true/true/(absent|false) shape is a
 * lifecycle interruption; log values stay scalar even when an unexpected error is malformed. */
function inspectLifecycleReset(error: unknown): LifecycleResetInspection {
  if (typeof error !== "object" || error === null)
    return {
      flags: { retryable: undefined, durableObjectReset: undefined, overloaded: undefined },
      retryableLifecycleReset: false,
    };
  try {
    const candidate = error as {
      retryable?: unknown;
      durableObjectReset?: unknown;
      overloaded?: unknown;
    };
    const retryable = candidate.retryable;
    const durableObjectReset = candidate.durableObjectReset;
    const overloaded = candidate.overloaded;
    return {
      flags: {
        retryable: typeof retryable === "boolean" ? retryable : undefined,
        durableObjectReset:
          typeof durableObjectReset === "boolean" ? durableObjectReset : undefined,
        overloaded: typeof overloaded === "boolean" ? overloaded : undefined,
      },
      retryableLifecycleReset:
        retryable === true &&
        durableObjectReset === true &&
        (overloaded === undefined || overloaded === false),
    };
  } catch {
    return {
      flags: { retryable: undefined, durableObjectReset: undefined, overloaded: undefined },
      retryableLifecycleReset: false,
    };
  }
}

function lifecycleLog(
  event: "stream-lifecycle-recovery-failed" | "stream-lifecycle-recovery-expected-interruption",
  operation: string,
  after: number,
  attempt: number,
  flags: RuntimeFlags,
): void {
  console.info(
    JSON.stringify({
      event,
      context,
      operation,
      after,
      attempt,
      utc: new Date().toISOString(),
      ...flags,
    }),
  );
}

beforeAll(async () => {
  if (!process.env.WORKER_BASE_URL) return;
  context = freshCtx("lifecycle-recovery");
  const itx = openItx(context);
  seededOffsets = [];
  console.info(
    JSON.stringify({
      event: "stream-lifecycle-recovery-seed",
      context,
      utc: new Date().toISOString(),
    }),
  );
  for (let n = 0; n < EVENT_COUNT; n++) {
    const [event] = await append(itx, { type: "blob", payload: { n, blob: blobFor(n) } });
    seededOffsets.push(event.offset as number);
  }
}, 600_000);

deployed(
  "idempotent lifecycle recovery: permits at most one classified reset across physical 144 MiB reads and the known user-tally snapshot without duplicate rows",
  { timeout: 300_000 },
  async () => {
    let itx = openItx(context);
    let recoveryAttempt = 0;
    const recoveries: { operation: string; after: number; attempt: number }[] = [];

    async function retryKnownIdempotentOperation<T>(
      operation: string,
      after: number,
      run: () => Promise<T>,
    ): Promise<T> {
      try {
        return await run();
      } catch (error) {
        const inspection = inspectLifecycleReset(error);
        lifecycleLog(
          "stream-lifecycle-recovery-failed",
          operation,
          after,
          recoveryAttempt,
          inspection.flags,
        );
        if (!inspection.retryableLifecycleReset || recoveryAttempt >= 1) throw error;
        recoveryAttempt++;
        recoveries.push({ operation, after, attempt: recoveryAttempt });
        lifecycleLog(
          "stream-lifecycle-recovery-expected-interruption",
          operation,
          after,
          recoveryAttempt,
          inspection.flags,
        );
        // A fresh public project handle discards a native stub poisoned by the failed operation.
        // This does not replay a write or re-enable a processor; it repeats only the exact pure read.
        disposeSessions();
        itx = openItx(context);
        await sleep(250);
        try {
          return await run();
        } catch (retryError) {
          const retryInspection = inspectLifecycleReset(retryError);
          lifecycleLog(
            "stream-lifecycle-recovery-failed",
            operation,
            after,
            recoveryAttempt,
            retryInspection.flags,
          );
          throw retryError;
        }
      }
    }

    const seen = new Map<number, string>();
    let after = 0;
    for (;;) {
      const page = (await retryKnownIdempotentOperation("itx.builtins.readEvents", after, () =>
        itx.invoke(["itx", "builtins", ["readEvents", after, 500]]),
      )) as {
        events: { offset: number; type: string; payload: any }[];
        scannedThroughOffset: number;
      };
      for (const event of page.events)
        if (event.type === "blob" && typeof event.payload.blob === "string")
          seen.set(event.offset, event.payload.blob);
      if (page.scannedThroughOffset <= after) break;
      after = page.scannedThroughOffset;
    }

    // The original separate read test disposed all client sessions before the catch-up test. Preserve
    // that workload boundary before its once-only enablement.
    disposeSessions();
    itx = openItx(context);
    // Original resource pressure order: read the whole 144 MiB log first, then enable exactly once.
    // The known user-tally fixture's pure reducer counts committed event types and has no side effect.
    await enableFixtureProcessor(itx, "user-tally");
    const snapshot = (await retryKnownIdempotentOperation(
      "itx.facets.get('user-tally').snapshot()",
      after,
      () => itx.invoke("itx.facets.get('user-tally').snapshot()"),
    )) as { state?: { counts?: Record<string, number> } };

    expect([...seen.keys()].sort((a, b) => a - b)).toEqual(seededOffsets);
    for (let n = 0; n < EVENT_COUNT; n++)
      expect(seen.get(seededOffsets[n]) === blobFor(n), `event ${n} byte-identical`).toBe(true);
    expect(seen).toHaveLength(EVENT_COUNT);
    expect(snapshot.state?.counts?.blob).toBe(EVENT_COUNT);

    // This is a bounded tail after the full read, not a second materialization of the 144 MiB log.
    // It uses the same one-interruption budget and proves the once-only enablement wrote one row.
    const tail = (await retryKnownIdempotentOperation("itx.builtins.readEvents", after, () =>
      itx.invoke(["itx", "builtins", ["readEvents", after, 500]]),
    )) as { events: { type: string; payload?: { name?: string } }[] };
    expect(
      tail.events.filter(
        (event) =>
          event.type === "events.iterate.com/stream/subscription-configured" &&
          event.payload?.name === "user-tally",
      ),
    ).toHaveLength(1);
    expect(recoveryAttempt).toBeLessThanOrEqual(1);
    expect(recoveries).toHaveLength(recoveryAttempt);
    for (const recovery of recoveries) {
      expect(recovery.attempt).toBe(1);
      expect(recovery.after).toBeGreaterThanOrEqual(0);
      expect(recovery.operation).toMatch(
        /^(itx\.builtins\.readEvents|itx\.facets\.get\('user-tally'\)\.snapshot\(\))$/,
      );
    }
  },
);
