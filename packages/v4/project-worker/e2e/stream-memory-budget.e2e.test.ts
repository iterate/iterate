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
import {
  append,
  codeOf,
  freshCtx,
  openItx,
  readAll,
  readHead,
  rejection,
} from "./support/client.ts";
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
  // A non-secret, stdout-searchable correlation marker for the deployed resource run. It is
  // deliberately not a stream event: the seeded log remains exactly the 24 blob rows this proof
  // specifies.
  console.info(
    JSON.stringify({
      event: "stream-memory-budget-seed",
      context: seededCtx,
      utc: new Date().toISOString(),
    }),
  );
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
      let page: Awaited<ReturnType<typeof itx.invoke>>;
      try {
        page = await itx.invoke(["itx", ["readEvents", after, 500]]);
      } catch (error) {
        const own = (field: string): unknown =>
          typeof error === "object" && error !== null && Object.hasOwn(error, field)
            ? (error as Record<string, unknown>)[field]
            : undefined;
        // Failure-only, redacted correlation for a deployed resource run. Keep this to the
        // invocation boundary: it neither retries nor changes the error the caller receives.
        console.info(
          JSON.stringify({
            event: "stream-memory-budget-read-failed",
            context: seededCtx,
            page: pages + 1,
            after,
            utc: new Date().toISOString(),
            name: own("name"),
            message: own("message"),
            code: own("code"),
            retryable: own("retryable"),
            durableObjectReset: own("durableObjectReset"),
          }),
        );
        throw error;
      }
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
    let phase = "enable";
    try {
      await enableFixtureProcessor(itx, "user-tally"); // consumes "*": counts committed events by type
      phase = "snapshot";
      const snapshot = await itx.invoke("itx.facets.get('user-tally').snapshot()");
      expect(snapshot.state?.counts?.blob).toBe(EVENT_COUNT);
    } catch (error) {
      const own = (field: string): unknown =>
        typeof error === "object" && error !== null && Object.hasOwn(error, field)
          ? (error as Record<string, unknown>)[field]
          : undefined;
      console.info(
        JSON.stringify({
          event: "stream-memory-budget-catchup-failed",
          context: seededCtx,
          phase,
          utc: new Date().toISOString(),
          name: own("name"),
          message: own("message"),
          code: own("code"),
          retryable: own("retryable"),
          overloaded: own("overloaded"),
          durableObjectReset: own("durableObjectReset"),
        }),
      );
      throw error;
    }
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

// The client→edge and edge→DO request is a real `itx.invoke(["itx", ["append", ...events]])`,
// not bare `Stream.append(...events)`. At 5,000 × 6,650-byte bodies its native serialized request is
// 33,430,027 bytes (under workerd's 32 MiB cap), while the receipt array with each event's offset,
// createdAt and path is 33,729,883 bytes. (The formerly-minimal 38,000 × 780 version cannot reach
// the serializer because JavaScript's call-argument limit rejects `Stream.append(...events)` first.)
// Before the receipt preflight, workerd rejected the RETURN after the DO transaction had committed:
// a caller without idempotency keys could retry and duplicate the entire batch. The coded pre-commit
// refusal below must leave no input rows. A fresh verification session may append the canonical
// `stream/woken` lifecycle row while it wakes the DO, so the proof pins that narrowly instead of
// pretending opening a distinct session is event-free.
test(
  "append receipt: a legal public RPC request cannot commit then overflow its native reply",
  { timeout: 300_000 },
  async () => {
    const context = freshCtx("membudget-append-receipt");
    const itx = openItx(context);
    const durableEventsBefore = await readAll(itx);
    const batch = Array.from({ length: 5_000 }, () => ({
      type: "blob",
      payload: { blob: "x".repeat(6_650) },
    }));
    // `append(itx, ...batch)` itself hits Node's call-argument limit before it reaches capnweb;
    // construct the public expression directly so this exercises the actual wire payload.
    const error = await rejection(
      itx.invoke(["itx", ["append", ...batch]]),
      "the oversized append receipt",
      180_000,
    );
    expect(codeOf(error)).toBe("APPEND_REPLY_TOO_LARGE");
    expect((error as { retryable?: unknown }).retryable).toBe(false);
    // A distinct session sees the durable store, not any in-memory state from the failed RPC. Its
    // wake is an explicitly-modelled durable lifecycle event; no other new row is acceptable.
    const durableEventsAfter = await readAll(openItx(context));
    expect(durableEventsAfter.slice(0, durableEventsBefore.length)).toEqual(durableEventsBefore);
    const rowsSinceReceipt = durableEventsAfter.slice(durableEventsBefore.length);
    expect(rowsSinceReceipt.map((event) => event.type)).toEqual(
      Array(rowsSinceReceipt.length).fill("events.iterate.com/stream/woken"),
    );
    expect(durableEventsAfter.filter((event) => event.type === "blob")).toEqual([]);
  },
);

test(
  "append: object-dense input is refused by structural admission before the DO decodes or writes it",
  { timeout: 300_000 },
  async () => {
    const context = freshCtx("membudget-dense");
    const durableHeadBefore = await readHead(openItx(context));
    const itx = openItx(context);
    const itemCount = 838_820; // One [ [] ] item this many times is ~4 MiB JSON, ~76 MiB parsed.
    const error = await rejection(
      append(itx, {
        type: "dense",
        payload: { items: Array.from({ length: itemCount }, () => [[]]) },
      }),
      "the object-dense append",
      180_000,
    );
    // Wire-shape admission fires before Capnweb parses the value, so this is deliberately
    // classified at the public RPC boundary rather than as a decoded stream event.
    expect(codeOf(error)).toBe("RPC_ADMISSION_REJECTED");
    expect((error as { retryable?: unknown }).retryable).toBe(false);
    expect(await readHead(openItx(context))).toBe(durableHeadBefore);
  },
);
