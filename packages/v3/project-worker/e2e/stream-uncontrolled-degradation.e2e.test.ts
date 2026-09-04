// stream-uncontrolled-degradation.e2e.test.ts — THE CRASH HUNT against a REAL Durable Object: the
// ways a client can still drive the clean-room platform into UNCONTROLLED degradation (an isolate
// reset) on the DEPLOYED worker, past the memory hygiene that landed 2026-09-04 (byte-budgeted reads,
// the 8 MiB append ceiling, the 8 MiB per-row delivery backlog). Those bound ONE request; this file
// hunts what CONCURRENCY and FAN-OUT still get past them. Run it deployed, ONE file at a time (a
// laptop's network flakes under parallel files):
//
//   WORKER_BASE_URL=https://project-worker.iterate.workers.dev \
//     npx vitest run --config e2e/vitest.config.ts stream-uncontrolled-degradation
//
// ⚠️  WARNING — THIS FILE DELIBERATELY RESETS DURABLE OBJECTS (and hammers the shared /api edge). It
// must NEVER point at anything but the throwaway POC worker (project-worker.iterate.workers.dev):
// every row uses a FRESH ctx = its own DO, and a reset only clears in-memory state (the durable log
// survives — the recovery row proves the ctx is not poisoned). Do not run it against a real
// deployment.
//
// THE HOUSE CONVENTION (stream-memory-budget.e2e.ts): a known-red proof is `test.fails` whose body
// asserts the HEALTHY expectation ("no isolate reset") — currently RED on the deployed worker, so the
// assertion throws and `test.fails` is green; the comment names what it dies of and the exact message
// observed. A ceiling that HOLDS is a plain `test`. Local workerd runs NullIsolateLimitEnforcer (NO
// memory limit), so the reset rows only prove out on the DEPLOYED worker; locally they document the
// 32 MiB Workers-RPC half at most.
//
// WHAT WAS OBSERVED (deployed, live-43, 2026-09-04). Every reset arrives as
// `Durable Object's isolate exceeded its memory limit and was reset.` with `.overloaded` +
// `.durableObjectReset` stamped, and the ctx recovers on the very next call (the log is durable):
//   • RED  concurrent readers      — 24 sessions paging one 144 MiB log at once reset the DO (8 hold);
//   • RED  slow live client        — a subscriber whose callback never resolves resets the PRODUCER DO;
//   • RED  large ephemeral fan-out  — 30 × 7 MiB ephemerals to 10 facets reset the parent DO (0 hold);
//   • edge concurrent big appends   — 8 × 28 MiB at once: no DO resets; 0–1 sessions lose their socket (1006);
//   • hold poison facet             — a hoarding reduce wedges on the coded checkpoint ceiling, the parent survives;
//   • hold loaded-isolate OOM       — a runaway WorkerEntrypoint OOMs its OWN isolate, the parent survives;
//   • hold recovery                 — a reset is transient, not a poison loop.

import { beforeAll, expect, test } from "vitest";
import { append, codeOf, freshCtx, openItx } from "./support/client.ts";

/** Local workerd enforces no memory limit, so every row here is DEPLOYED-ONLY: locally the file
 *  skips (and its 300 MiB of uploads would only starve the parallel lane's other files). */
const LOCAL = /^https?:\/\/(127\.0\.0\.1|localhost)\b/.test(process.env.WORKER_BASE_URL ?? "");
const deployed = test.skipIf(LOCAL);

const MiB = 1024 * 1024;
/** A blob of `chars` code units — the payload that fills a body toward the 8 MiB append ceiling. */
const blob = (chars: number): string => "q".repeat(chars);

/** The stamped signal of an UNCONTROLLED reset (platform-facts.md §4): `.durableObjectReset` after the
 *  DO → edge → capnweb hops, or the raw message if a hop dropped the stamp. NOT a loaded-isolate OOM
 *  ("Worker exceeded memory limit.", `.overloaded` only) and NOT a facet wedge (SQLITE_TOOBIG). */
const isDurableObjectReset = (e: any): boolean =>
  e != null &&
  (e.durableObjectReset === true ||
    /isolate exceeded its memory limit and was reset/i.test(String(e.message ?? e)));

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

// ── the shared 144 MiB seed for the read-driven rows (a reset between them is fine: the log is
// durable and the next call re-materializes the context) ──

const SEED_EVENT_COUNT = 24;
const SEED_EVENT_CHARS = 6 * MiB;
let seededCtx: string;

beforeAll(async () => {
  if (LOCAL) return;
  seededCtx = freshCtx("degrade-seed");
  const itx = openItx(seededCtx);
  for (let n = 0; n < SEED_EVENT_COUNT; n++)
    await append(itx, { type: "blob", payload: { n, blob: blob(SEED_EVENT_CHARS) } });
}, 600_000);

// ─────────────────────────────── RED: the reproducible resets ───────────────────────────────

deployed.fails(
  "CONCURRENT READERS: 24 sessions paging one 144 MiB log at once reset the DO — the per-read byte budget bounds ONE read, never N sharing the isolate (`Durable Object's isolate exceeded its memory limit and was reset.`, .overloaded/.durableObjectReset; 8 readers HOLD)",
  { timeout: 300_000 },
  async () => {
    const readers = Array.from({ length: 24 }, () => openItx(seededCtx));
    const results = await Promise.all(readers.map((itx) => settle(pageToHead(itx))));
    const resetErrors = results.flatMap((r) => (!r.ok && isDurableObjectReset(r.e) ? [r.e] : []));
    // HEALTHY expectation: every page fits the 8 MiB budget, so all 24 readers finish and none resets.
    // Deployed: ~all 24 reset (24 × ~6 MiB pages materialize in the one DO isolate at once).
    expect(
      resetErrors.length,
      `${resetErrors.length}/24 concurrent readers reset the DO: ${String(resetErrors[0]?.message ?? "")}`,
    ).toBe(0);
  },
);

deployed.fails(
  "SLOW LIVE CLIENT: a subscriber whose callback never resolves resets the PRODUCER DO — each fire-and-forget push stays in flight, retaining its bytes on the DO until it OOMs at ~125 × 1 MiB (`…isolate exceeded its memory limit and was reset.`, .durableObjectReset). A fast-ack subscriber takes the same flood cleanly",
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

deployed.fails(
  "LARGE EPHEMERAL FAN-OUT: a burst of 30 × 7 MiB ephemerals fanned out to 10 facets resets the parent DO — each push to each facet is an in-flight loopback RPC copy (10 × 7 MiB) on top of the burst (`…isolate exceeded its memory limit and was reset.`, .durableObjectReset). The SAME burst to 0 facets is absorbed",
  { timeout: 300_000 },
  async () => {
    const itx = openItx(freshCtx("degrade-fanout"));
    for (let i = 0; i < 10; i++)
      await itx.enableProcessor(`sink${i}`, {
        source: SINK_SOURCE,
        className: "SinkDurableObject",
        consumes: ["blob"],
      });
    // Fire all 30 at once (pipelined) — the fan-out amplifies the concurrent transient past ~290 MiB.
    const results = await Promise.all(
      Array.from({ length: 30 }, (_, i) =>
        settle(append(itx, { type: "blob", ephemeral: true, payload: { i, blob: blob(7 * MiB) } })),
      ),
    );
    const resets = results.filter((r) => !r.ok && isDurableObjectReset(r.e));
    // HEALTHY expectation: the fan-out is bounded (the 8 MiB per-row backlog budget), so all commit.
    expect(
      resets.length,
      `${resets.length}/30 appends reset the parent DO under the 10-facet fan-out`,
    ).toBe(0);
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
deployed(
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
    for (const failure of failures) expect(failure).toMatch(/1006/); // only ever the edge's socket close
    const committed = results.filter((r) => r.ok).length;
    expect(
      committed,
      `${committed}/8 committed; failures:\n${failures.join("\n")}`,
    ).toBeGreaterThanOrEqual(7);
    for (const r of results) if (r.ok) expect((r.v as { offset: number }[]).length).toBe(4); // a landed batch is whole
  },
);

deployed(
  "POISON FACET: a processor whose reduce hoards every payload outgrows the 2 MB checkpoint cell — snapshot() rejects coded REDUCE_CHECKPOINT_TOO_LARGE on EVERY call (a poison-loop facet, cleared only by disableProcessor), but the parent DO stays fully serviceable (a controlled WEDGE, never a reset)",
  { timeout: 300_000 },
  async () => {
    const ctx = freshCtx("degrade-poison");
    const itx = openItx(ctx);
    for (let n = 0; n < 16; n++)
      await append(itx, { type: "blob", payload: { n, blob: blob(4 * MiB) } });
    await itx.enableProcessor("hoarder", {
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

deployed(
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

deployed(
  "RECOVERY: a reset is TRANSIENT, never a poison loop — after 24 concurrent readers reset the seeded ctx, the next call re-materializes it from the durable log (core snapshot + a small append both land)",
  { timeout: 300_000 },
  async () => {
    // Provoke the reset (reuses the 144 MiB seed — no extra upload).
    const readers = Array.from({ length: 24 }, () => openItx(seededCtx));
    const results = await Promise.all(readers.map((itx) => settle(pageToHead(itx))));
    expect(
      results.some((r) => !r.ok && isDurableObjectReset(r.e)),
      "expected a reset to provoke",
    ).toBe(true);
    // Recovery: a fresh session serves the core snapshot and commits an append.
    const itx = openItx(seededCtx);
    const snapshot = (await itx.invoke("itx.facets.get('core').snapshot()")) as { offset: number };
    expect(snapshot.offset).toBeGreaterThan(0);
    const [ev] = await append(itx, { type: "recovery-marker" });
    expect(ev.offset).toBeGreaterThan(0);
  },
);
