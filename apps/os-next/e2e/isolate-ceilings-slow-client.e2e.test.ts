// e2e/isolate-ceilings-slow-client.e2e.test.ts — the suite's longest single row, in a file of its own so it
// runs beside the rest: a live subscriber whose callback never resolves, and the producer that floods past
// the DO's in-flight budget. Deployed-only, like the rest of isolate-ceilings-deployed.
import { expect } from "vitest";
import { append, freshCtx, openItx } from "./support/client.ts";
import { MiB, blob, isDurableObjectReset, settle } from "./support/isolate-ceilings.ts";
import { deployedOnly } from "./support/project-host.ts";

// A stalled live subscriber (a callback that never returns) no longer resets the PRODUCER: past the
// DO's in-flight budget (subscription-delivery.ts DELIVERY_IN_FLIGHT_BUDGET_CHARS) its pushes are
// DROPPED with a warn (the client heals by read), so the producer floods on. BORN RED: each
// fire-and-forget push stayed in flight, retaining its bytes on the DO until it reset at ~125 × 1 MiB
// (flipped 2026-09-04, the per-context ledger).
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
    for (let i = 0; i < 300; i++) {
      const r = await settle(
        append(producer, { type: "chunk", ephemeral: true, payload: { i, blob: blob(1 * MiB) } }),
      );
      if (!r.ok) {
        if (isDurableObjectReset(r.e)) reset = r.e;
        break; // the DO is gone; stop flooding
      }
    }
    // HEALTHY expectation: a stalled subscriber blocks nothing but itself, so the producer floods on.
    expect(
      reset,
      `the producer DO reset under the stalled subscriber: ${String(reset?.message ?? "")}`,
    ).toBeUndefined();
  },
);
