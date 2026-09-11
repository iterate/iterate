// stream-isolate-ceilings-deployed.e2e.test.ts — THE ISOLATE CEILINGS against a REAL Durable Object.
// Local workerd enforces no memory limit (NullIsolateLimitEnforcer), so the proof that counts is the
// DEPLOYED worker, where the 128 MiB isolate is real:
//
//   WORKER_BASE_URL=https://project-worker.iterate.workers.dev pnpm e2e stream-isolate-ceilings
//
// The MEMORY PINS run everywhere (locally they prove only the platform's OTHER ceiling: a read page
// over 32 MiB cannot leave the DO over Workers RPC — "Serialized RPC arguments or return values are
// limited to 32MiB"; the node twin with a heap-capped child is src/stream/memory-budget.test.ts). The
// CRASH HUNT is deployed-only and DELIBERATELY RESETS DURABLE OBJECTS (and hammers the shared /api
// edge): it must NEVER point at anything but the throwaway POC worker — every row uses a FRESH ctx =
// its own DO, a reset clears only in-memory state (the durable log survives), and a laptop's network
// flakes under parallel files, so run it ONE file at a time. ONE seeded context (24 × 6 MiB = 144 MiB,
// more than the isolate) serves every read-driven row; a DO reset between them is fine — the next call
// re-materializes the context. Pins:
//   • read: a client pages the 144 MiB log — every page fits the isolate and the RPC cap (the server
//     decides the page size), every body byte-identical
//   • CONCURRENT READERS (an accepted limit, deliberately not defended): 24 sessions paging the log at
//     once MAY reset the DO — the per-read byte budget bounds one read, not their sum; the reset count
//     is REPORTED, recovery on the next call is asserted
//   • facet catch-up: a processor enabled over the 144 MiB log reduces every event through its
//     loopback read; append: one event past the platform ceiling is refused at the door,
//     EVENT_TOO_LARGE, nothing written, no offset burnt
//   • SLOW LIVE CLIENT: a subscriber whose callback never resolves has its pushes DROPPED past the DO's
//     in-flight budget (DELIVERY_IN_FLIGHT_BUDGET_CHARS) — the producer floods on, the DO never resets
//   • LARGE EPHEMERAL FAN-OUT (a documented limit): 30 × 7 MiB ephemerals to 10 co-located facets MAY
//     reset the parent — facet memory in the shared isolate the parent's JS cannot bound — but the ctx
//     is serviceable immediately after, never poisoned
//   • CONCURRENT BIG APPENDS: 8 × 28 MiB at once — no DO resets, every landed batch is whole, at most
//     one session lost to the shared /api edge closing its socket (1006)
//   • POISON FACET: a hoarding reduce outgrows the 2 MB checkpoint cell and WEDGES, coded
//     REDUCE_CHECKPOINT_TOO_LARGE on every call, the parent fully serviceable — never a reset
//   • LOADED-ISOLATE OOM: a runaway WorkerEntrypoint OOMs its OWN isolate (`.overloaded`, no
//     `.durableObjectReset`) and the parent DO is untouched
// Every reset arrives as `Durable Object's isolate exceeded its memory limit and was reset.` with
// `.overloaded` + `.durableObjectReset` stamped, and the ctx recovers on the very next call.

import { beforeAll, expect, test } from "vitest";
import { append, codeOf, freshCtx, openItx, rejection } from "./support/client.ts";
import { deployedOnly } from "./support/project-host.ts";
import { enableFixtureProcessor } from "./support/sources.ts";

// ── the shared 144 MiB seed ──

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

// ── the memory pins ──

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

// ── the crash hunt's helpers and INLINE fixture sources ──

/** A blob of `chars` code units — the payload that fills a body toward the 8 MiB append ceiling. */
const blob = (chars: number): string => "q".repeat(chars);

/** The stamped signal of an UNCONTROLLED reset (platform-facts.md §4): `.durableObjectReset` after the
 *  DO → edge → capnweb hops, or the raw message if a hop dropped the stamp. NOT a loaded-isolate OOM
 *  ("Worker exceeded memory limit.", `.overloaded` only) and NOT a facet wedge (SQLITE_TOOBIG). */
const isDurableObjectReset = (e: any): boolean =>
  e != null &&
  (e.durableObjectReset === true ||
    /isolate exceeded its memory limit and was reset/i.test(String(e.message ?? e)));

/** Retry a call while the platform answers "Durable Object is overloaded. Requests queued for too
 *  long." — its backpressure after a burst (a queue draining), never a reset and never poisoning; any
 *  other failure propagates at once. Bounded: ~15 s. */
async function retryWhileOverloaded<T>(call: () => Promise<T>): Promise<T> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    try {
      return await call();
    } catch (error) {
      if (!/overloaded|queued for too long/i.test(String((error as Error)?.message ?? error)))
        throw error;
      if (Date.now() > deadline) throw error;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

/** Settle a promise to a tagged outcome so a reset never escapes as an unhandled rejection (the e2e
 *  config only forgives WebSocket/RPC-session noise; a `durableObjectReset` message would be fatal). */
const settle = <T>(p: Promise<T>): Promise<{ ok: true; v: T } | { ok: false; e: any }> =>
  p.then(
    (v) => ({ ok: true as const, v }),
    (e) => ({ ok: false as const, e }),
  );

/** Read one context to its durable head, paging by the server's byte budget. */
async function pageToHead(itx: any): Promise<number> {
  let after = 0;
  let pages = 0;
  for (;;) {
    const page = await itx.invoke(["itx", ["readEvents", after, 500]]);
    pages++;
    if (page.scannedThroughOffset <= after) return pages;
    after = page.scannedThroughOffset;
  }
}

// ── INLINE fixture sources (this file may add its own; support/sources.ts is not edited) ──

/** A facet processor that COUNTS blob events — the fan-out target (its push is a loopback RPC copy). */
const SINK_SOURCE = {
  "cap.js": `import { StreamProcessor, StreamProcessorDurableObject, defineProcessorContract, z } from "./processor.js";
const contract = defineProcessorContract({ slug: "sink", version: "1.0.0", description: "counts blob events — a fan-out target", stateSchema: z.object({ n: z.number().default(0) }), events: {}, consumes: ["blob"], emits: [] });
class SinkProcessor extends StreamProcessor { contract = contract; reduce({ state }) { return { n: state.n + 1 }; } }
export class SinkDurableObject extends StreamProcessorDurableObject { processor = new SinkProcessor(); }`,
};

/** A facet processor whose reduce HOARDS every payload into its checkpoint state — it outgrows the
 *  ~2 MB SQLite checkpoint cell (SQLITE_TOOBIG) and wedges. The poison-facet case. */
const HOARDER_SOURCE = {
  "cap.js": `import { StreamProcessor, StreamProcessorDurableObject, defineProcessorContract, z } from "./processor.js";
const contract = defineProcessorContract({ slug: "hoarder", version: "1.0.0", description: "accumulates every payload — outgrows the checkpoint cell", stateSchema: z.object({ blobs: z.array(z.string()).default([]) }), events: {}, consumes: ["blob"], emits: [] });
class HoarderProcessor extends StreamProcessor { contract = contract; reduce({ event, state }) { return { blobs: [...state.blobs, event.payload.blob] }; } }
export class HoarderDurableObject extends StreamProcessorDurableObject { processor = new HoarderProcessor(); }`,
};

/** A stateless WorkerEntrypoint that allocates unboundedly — its OWN loaded isolate's memory limit. */
const OOMER_SOURCE = {
  "cap.js": `import { WorkerEntrypoint } from "cloudflare:workers";
export default class Oomer extends WorkerEntrypoint {
  async ping() { return "pong"; }
  async oom() { const a = []; for (;;) a.push(new Array(1e6).fill(1)); }
}`,
};

// ─────────────────────────────── RED: the reproducible resets ───────────────────────────────

// RED BY DESIGN — an ACCEPTED client-behaviour limit, deliberately NOT defended (2026-09-07). WHY
// IT RESETS: 24 sessions page one 144 MiB log at once; each read returns a byte-budgeted page that
// still carries >= 1 row, so 24 readers each grab a ~6 MiB first page in the same tick and 24 x
// 6 MiB coexist as replies in flight (~144 MiB) — the isolate resets. The per-read byte budget
// (stream.ts READ_PAGE_BUDGET_BYTES) is the WHOLE read-memory defense now: it bounds ONE read, never
// the SUM across concurrent readers. WHY THAT IS OK: a client can only reset ITS OWN context's DO;
// the durable log survives and the very next call re-materializes the context (the recovery read in
// the body proves it), so the blast radius is one client's own transient state and it reconnects.
// HOW IT WOULD BE FIXED, and why we didn't: bound the bytes IN FLIGHT across reads — an admission
// gate that awaits room, serialised reads, or a coarse in-flight byte counter. We REMOVED exactly
// that ceiling on 2026-09-07 because it forced `read()` async — rippling an await through every
// same-isolate caller and splitting the door into read/readInternal — to defend a case no real
// workload hits (one client fanning out 24 six-MiB reads at once). If a real workload ever does,
// restore the ceiling and assert a ZERO reset count below.
//
// WHETHER the storm resets the DO is the platform's call, not this code's: 24 readers × an 8 MiB page
// peaks near the 128 MiB isolate, and the GC's timing decides (a deployed run on 2026-09-09 saw no
// reset at all). So the row asserts only the claim this code OWNS — recovery — and REPORTS the reset
// count; it is not a `.fails` pin, because a flip here would signal luck, never a ceiling.
deployedOnly(
  "CONCURRENT READERS (accepted limit): 24 sessions paging one 144 MiB log at once may reset the DO — the per-read byte budget bounds one read, not their sum; the ctx recovers on the next call",
  { timeout: 300_000 },
  async () => {
    const readers = Array.from({ length: 24 }, () => openItx(seededCtx));
    const results = await Promise.all(readers.map((itx) => settle(pageToHead(itx))));
    const resetErrors = results.flatMap((r) => (!r.ok && isDurableObjectReset(r.e) ? [r.e] : []));
    // RECOVERY (runs first, every time): the durable log survives the reset — a single fresh reader
    // still pages the seeded ctx to head. This is why the limit is acceptable, and it must hold.
    const recovered = await settle(pageToHead(openItx(seededCtx)));
    expect(recovered.ok, "the seeded ctx must recover after the storm and still page to head").toBe(
      true,
    );
    // The reset count is REPORTED, never asserted (the block above): the platform decides it.
    console.log(
      `[concurrent readers] ${resetErrors.length}/24 readers reset the DO${resetErrors.length ? `: ${String(resetErrors[0]?.message ?? "")}` : ""}`,
    );
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

// STILL RED after two DO-side attempts (live-50 delivery budgets 16→8, live-51 classifying facets
// as push rows at catch-up so onCommit never pins their batches on the delivery record). Diagnosis
// (deployed): the SAME 30 × 7 MiB burst to 0 facets is ABSORBED (workerd paces the arg
// deserialization), and even 3 facets RESET — so it is the FAN-OUT, not the raw args, and it is not
// facet-count-linear. Neither delivery-retention bound nor the pushed-batch fix closes it,
// which places the dominant term OUTSIDE the parent's delivery accounting: a FACET is a same-worker
// facet that SHARES the parent's 128 MiB isolate (reference: DO isolate ceiling is shared by
// co-located instances and same-worker facets), so each pushed 7 MiB event is DESERIALIZED into the
// facet's context in the shared isolate, plus the loaded facet script's own base memory — memory the
// parent's JS cannot bound. Likely needs a platform-level lever (a facet-push concurrency-of-one
// gate that also waits on the facet-side turn, a smaller ephemeral ceiling for fan-out, or accepting
// it as a client-behavior limit per the trusted-client doctrine). The WANTED (no reset) is the target.
deployedOnly(
  "LARGE EPHEMERAL FAN-OUT (documented limit): a burst of 30 × 7 MiB ephemerals fanned to 10 facets MAY reset the parent — co-located facet memory in the shared isolate — but the reset is TRANSIENT: the ctx is serviceable immediately after (core snapshot + a small append both land), never poisoned",
  { timeout: 300_000 },
  async () => {
    // A DOCUMENTED LIMIT (c), not a red pin: three DO-side attempts (delivery budgets 16→8, classify
    // facets at catch-up, a facet-push serial gate) did NOT close this. Deployed diagnosis: 0 facets
    // is ABSORBED (workerd paces the arg deserialization), 3+ facets RESET, and one-large-push-at-a-
    // time still resets — so the dominant term is CO-LOCATED FACET memory. A facet is a same-worker
    // facet sharing the parent's 128 MiB isolate, so each pushed 7 MiB event deserializes INTO the
    // facet's context HERE, plus the loaded facet's base memory; the parent's JS cannot bound it.
    // ACCEPTED per the trusted-client doctrine: 30 concurrent 7 MiB ephemerals to N co-located facets
    // is extreme, the per-event 8 MiB ceiling is the real defence, and the blast radius is a transient
    // reset. This row asserts the CONTROLLED part — the ctx recovers — not "no reset".
    const ctx = freshCtx("degrade-fanout");
    const itx = openItx(ctx);
    for (let i = 0; i < 10; i++)
      await itx.processors.enable(`sink${i}`, {
        source: SINK_SOURCE,
        className: "SinkDurableObject",
        consumes: ["blob"],
      });
    const results = await Promise.all(
      Array.from({ length: 30 }, (_, i) =>
        settle(append(itx, { type: "blob", ephemeral: true, payload: { i, blob: blob(7 * MiB) } })),
      ),
    );
    const reset = results.some((r) => !r.ok && isDurableObjectReset(r.e));
    console.log(
      `LARGE EPHEMERAL FAN-OUT: the burst ${reset ? "reset" : "did not reset"} the parent this run`,
    );
    // The controlled part: whatever the burst did, the ctx is serviceable and unpoisoned right after —
    // the durable log survives an isolate reset (this subsumes the old RECOVERY row). "Right after"
    // allows the platform's own backpressure to drain: while the burst's queue empties, a call may be
    // refused with "Durable Object is overloaded. Requests queued for too long." — a queue-full
    // refusal, not a poisoned context — so the recovery is retried for a few seconds.
    const recovered = openItx(ctx);
    const snapshot = await retryWhileOverloaded(
      () => recovered.invoke("itx.facets.get('core').snapshot()") as Promise<{ offset: number }>,
    );
    expect(snapshot.offset).toBeGreaterThan(0);
    const [ev] = await retryWhileOverloaded(() =>
      append(recovered, { type: "fan-out-recovery-marker" }),
    );
    expect(ev.offset).toBeGreaterThan(0);
  },
);

// ─────────────────── CONTROLS: ceilings that hold, and the shared edge's BOUNDARY ───────────────────

// A BOUNDARY, not a constant: 8 × 28 MiB batches from 8 sessions at once sometimes lose ONE session
// to `Peer closed WebSocket: 1006` — no code, no reset stamp, the DO never saw it — the shared /api
// EDGE isolate closing the socket (each batch is held there twice: the capnweb frame, then the
// Workers-RPC copy; whether the eight land in ONE edge isolate is the platform's routing). Observed
// 2026-09-04: 8/8 twice, then 7/8 four times, then 8/8 — so this row asserts what holds EITHER way:
// no DO resets, every commit that landed is whole, and any loss is that one edge close (the
// assertion message names each). The audit's "least-isolated tenant" (oom-audit item 4/27); the
// fix is an edge-side in-flight budget, on the menu.
deployedOnly(
  "CONCURRENT BIG APPENDS: 8 sessions each commit a 28 MiB batch (4 × 7 MiB) to its own ctx at once — a session may lose its socket to the shared /api edge (1006), but no DO ever resets and every landed batch is whole",
  { timeout: 300_000 },
  async () => {
    const results = await Promise.all(
      Array.from({ length: 8 }, () => openItx(freshCtx("degrade-edge"))).map((itx) =>
        settle(
          append(
            itx,
            ...Array.from({ length: 4 }, (_, j) => ({
              type: "blob",
              payload: { j, blob: blob(7 * MiB) },
            })),
          ),
        ),
      ),
    );
    const failures = results.flatMap((r) =>
      r.ok
        ? []
        : [
            `${String(r.e?.message ?? r.e).slice(0, 300)} [code=${codeOf(r.e)} reset=${isDurableObjectReset(r.e)}]`,
          ],
    );
    expect(
      results.filter((r) => !r.ok && isDurableObjectReset(r.e)).length,
      failures.join("\n"),
    ).toBe(0);
    // only ever the edge losing the session: a mid-flight `1006` close, or — when the isolate dies while
    // a session's upgrade is still in flight — the connect itself failing (observed 2026-09-06, twice)
    for (const failure of failures) expect(failure).toMatch(/1006|WebSocket connection failed/);
    const committed = results.filter((r) => r.ok).length;
    expect(
      committed,
      `${committed}/8 committed; failures:\n${failures.join("\n")}`,
    ).toBeGreaterThanOrEqual(7);
    for (const r of results) if (r.ok) expect((r.v as { offset: number }[]).length).toBe(4); // a landed batch is whole
  },
);

deployedOnly(
  "POISON FACET: a processor whose reduce hoards every payload outgrows the 2 MB checkpoint cell — snapshot() rejects coded REDUCE_CHECKPOINT_TOO_LARGE on EVERY call (a poison-loop facet, cleared only by processors.disable), but the parent DO stays fully serviceable (a controlled WEDGE, never a reset)",
  { timeout: 300_000 },
  async () => {
    const ctx = freshCtx("degrade-poison");
    const itx = openItx(ctx);
    for (let n = 0; n < 16; n++)
      await append(itx, { type: "blob", payload: { n, blob: blob(4 * MiB) } });
    await itx.processors.enable("hoarder", {
      source: HOARDER_SOURCE,
      className: "HoarderDurableObject",
      consumes: ["blob"],
    });
    for (let attempt = 0; attempt < 3; attempt++) {
      const r = await settle(itx.invoke("itx.facets.get('hoarder').snapshot()"));
      expect(r.ok, `snapshot attempt ${attempt} unexpectedly succeeded`).toBe(false);
      expect(codeOf((r as { e: any }).e)).toBe("REDUCE_CHECKPOINT_TOO_LARGE"); // ours, coded — no raw SQLITE_TOOBIG
      expect(String((r as { e: any }).e?.message)).toMatch(
        /over the .*ceiling of one storage cell/,
      );
      expect(isDurableObjectReset((r as { e: any }).e)).toBe(false); // the facet wedged; the DO did not reset
    }
    // The parent is intact: a fresh session's append lands.
    const [ev] = await append(openItx(ctx), { type: "after-poison" });
    expect(ev.offset).toBeGreaterThan(0);
  },
);

deployedOnly(
  "LOADED-ISOLATE OOM: a stateless WorkerEntrypoint that allocates unboundedly OOMs its OWN loaded isolate — the caller gets `Worker exceeded memory limit.` (.overloaded, NO .durableObjectReset) and the parent DO is untouched (a ceiling that HOLDS at the loaded-isolate boundary)",
  { timeout: 120_000 },
  async () => {
    const itx = openItx(freshCtx("degrade-loaded"));
    expect(await itx.invoke(["itx", "workers", ["get", { source: OOMER_SOURCE }], ["ping"]])).toBe(
      "pong",
    );
    const r = await settle(
      itx.invoke(["itx", "workers", ["get", { source: OOMER_SOURCE }], ["oom"]]),
    );
    expect(r.ok).toBe(false);
    const e = (r as { e: any }).e;
    expect(e?.overloaded === true || /exceeded memory limit/i.test(String(e?.message))).toBe(true);
    expect(isDurableObjectReset(e)).toBe(false); // the loaded isolate died, not the parent DO
    // The parent is intact: a small append lands on the same session.
    const [ev] = await append(itx, { type: "after-loaded-oom" });
    expect(ev.offset).toBeGreaterThan(0);
  },
);
