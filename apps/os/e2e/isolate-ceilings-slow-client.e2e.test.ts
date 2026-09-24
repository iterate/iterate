// e2e/isolate-ceilings-slow-client.e2e.test.ts — the suite's longest single row, in a file of its own so it
// runs beside the rest: a live subscriber whose callback never resolves, and the producer that floods past
// the DO's in-flight budget. Deployed-only, like the rest of isolate-ceilings-deployed.
import { expect } from "vitest";
import { append, freshCtx, openItx } from "./support/client.ts";
import { MiB, blob, isDurableObjectReset, settle } from "./support/isolate-ceilings.ts";
import { deployedOnly } from "./support/project-host.ts";

// A stalled live subscriber (a callback that never returns) no longer resets the PRODUCER: past the
// DO's in-flight budget (subscription-delivery.ts DELIVERY_IN_FLIGHT_BUDGET_CHARS) its pushes are
// DROPPED with a warn (the client heals by read), so the producer floods on. Without that budget each
// fire-and-forget push stays in flight, retaining its bytes on the DO until it resets at ~125 × 1 MiB.
deployedOnly(
  "SLOW LIVE CLIENT: a subscriber whose callback never resolves has its pushes dropped past the DO in-flight budget — the producer floods on, the DO never resets",
  { timeout: 300_000 },
  async () => {
    const ctx = freshCtx("degrade-slow");
    // A live callback lent to the DO; it never returns, so every delivered push is retained in flight.
    await openItx(ctx).subscribe({
      name: "stall",
      consumes: ["chunk"],
      target: () => new Promise(() => {}),
    });
    const producer = openItx(ctx);
    let reset: any;
    // 160 × 1 MiB: past the 128 MiB isolate (the born-red version reset at ~125 MiB retained) with a
    // quarter's margin. The row is upload time, and one append at a time paid a round trip per MiB
    // (~180 ms in CI, 25 s); eight concurrent appenders keep the wire full — 9.5–15 s measured
    // 2026-09-22, the DO ingesting every MiB either way. A reset fails the append in hand and stops
    // every appender.
    let next = 0;
    const flood = async () => {
      while (next < 160 && !reset) {
        const i = next++;
        const r = await settle(
          append(producer, { type: "chunk", ephemeral: true, payload: { i, blob: blob(1 * MiB) } }),
        );
        if (!r.ok) {
          if (isDurableObjectReset(r.e)) reset = r.e;
          return; // the DO is gone; stop flooding
        }
      }
    };
    await Promise.all(Array.from({ length: 8 }, flood));
    // HEALTHY expectation: a stalled subscriber blocks nothing but itself, so the producer floods on.
    expect(
      reset,
      `the producer DO reset under the stalled subscriber: ${String(reset?.message ?? "")}`,
    ).toBeUndefined();
  },
);
