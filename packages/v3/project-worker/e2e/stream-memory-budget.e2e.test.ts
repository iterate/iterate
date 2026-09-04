// stream-memory-budget.e2e.test.ts — THE MEMORY PINS against a REAL Durable Object: a context whose
// log holds 24 × 6 MiB events (144 MiB — more than the 128 MiB isolate) must still be readable page
// by page, a processor must still catch up over it, and one event past the platform's own ceiling
// must be refused at the append door. The proof that counts is the DEPLOYED worker, where the
// isolate limit is real:
//
//   WORKER_BASE_URL=https://project-worker.iterate.workers.dev pnpm e2e --run stream-memory-budget
//
// Local workerd enforces no memory limit (NullIsolateLimitEnforcer), so locally these rows prove only
// the platform's OTHER ceiling: a read page over 32 MiB cannot leave the DO over Workers RPC
// ("Serialized RPC arguments or return values are limited to 32MiB"); before the fix they were red
// locally for that reason and red on the deployed worker for the isolate reset. The node twin with a
// heap-capped child is src/stream/memory-budget.test.ts. These rows were born `test.fails` (the house
// convention for a known-red proof) and flipped to `test` when the byte-budgeted read and the append
// ceiling landed (BUILD-LOG 2026-09-04).
//
// ONE seeded context serves the read pin and the facet pin (the seed is 144 MiB of upload); a DO
// reset between them is fine — the log is durable and the next call re-materializes the context.

import { beforeAll, expect, test } from "vitest";
import { append, codeOf, freshCtx, openItx, rejection } from "./support/client.ts";
import { enableFixtureProcessor } from "./support/sources.ts";

const MiB = 1024 * 1024;
const EVENT_COUNT = 24;
const EVENT_CHARS = 6 * MiB;
/** The seeded blob for event `n` — deterministic, so a read-back can be checked byte for byte. */
const blobFor = (n: number): string => String.fromCharCode(97 + (n % 26)).repeat(EVENT_CHARS);

let seededCtx: string;
let seededOffsets: number[] = [];

beforeAll(async () => {
  seededCtx = freshCtx("membudget");
  const itx = openItx(seededCtx);
  seededOffsets = [];
  for (let n = 0; n < EVENT_COUNT; n++) {
    const [event] = await append(itx, { type: "blob", payload: { n, blob: blobFor(n) } });
    seededOffsets.push(event.offset as number);
  }
}, 600_000);

test(
  "read: a client pages a 144 MiB log — every page fits the isolate and the RPC cap, every body byte-identical",
  { timeout: 300_000 },
  async () => {
    const itx = openItx(seededCtx);
    const seen = new Map<number, string>();
    let pages = 0;
    for (let after = 0; ; ) {
      const page = await itx.invoke(["itx", ["readEvents", after, 500]]);
      pages++;
      for (const event of page.events as { offset: number; type: string; payload: any }[])
        if (event.type === "blob") seen.set(event.offset, event.payload.blob);
      if (page.scannedThroughOffset <= after) break;
      after = page.scannedThroughOffset;
    }
    expect([...seen.keys()].sort((a, b) => a - b)).toEqual(seededOffsets);
    for (let n = 0; n < EVENT_COUNT; n++)
      expect(seen.get(seededOffsets[n]) === blobFor(n), `event ${n} byte-identical`).toBe(true);
    expect(pages).toBeGreaterThan(1); // the server decided the page size, not the caller's limit
  },
);

test(
  "facet catch-up: a processor enabled over a 144 MiB log reduces every event through its loopback read",
  { timeout: 300_000 },
  async () => {
    const itx = openItx(seededCtx);
    await enableFixtureProcessor(itx, "user-tally"); // consumes "*": counts committed events by type
    const snapshot = await itx.invoke("itx.facets.get('user-tally').snapshot()");
    expect(snapshot.state?.counts?.blob).toBe(EVENT_COUNT);
  },
);

test(
  "append: one event past the platform ceiling is refused at the door with EVENT_TOO_LARGE, nothing written",
  { timeout: 120_000 },
  async () => {
    const itx = openItx(freshCtx("membudget-door"));
    const [marker] = await append(itx, { type: "marker" });
    const error = await rejection(
      append(itx, { type: "blob", payload: { blob: "z".repeat(9 * MiB) } }),
      "a 9 MiB append",
      60_000,
    );
    expect(codeOf(error)).toBe("EVENT_TOO_LARGE");
    expect(error.message).toMatch(/32 ?MiB/); // the message says WHY: the platform's RPC ceiling
    const [next] = await append(itx, { type: "after" });
    expect(next.offset).toBe(marker.offset + 1); // the refused batch burned no offset, wrote nothing
  },
);
