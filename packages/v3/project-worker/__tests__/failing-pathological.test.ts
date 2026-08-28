// failing-pathological.test.ts — BUG-HUNT: pathological-shape and performance probes against
// the REAL worker (wrangler createTestHarness → local workerd, real DOs, real Worker Loader).
// Every test asserts CORRECT behavior; `test.fails` documents a bug verified by running this
// file. Perf assertions use generous workerd-local bounds and print the measured number.
// Run: pnpm exec vitest run --config vitest.harness.config.ts __tests__/failing-pathological.test.ts
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { startProjectHarness, type ProjectHarness } from "./harness.ts";

let harness: ProjectHarness;
beforeAll(async () => {
  harness = await startProjectHarness();
}, 120_000);
afterAll(async () => {
  await harness?.stop();
});

/** n-deep nested array with a 0 at the bottom: [[[…0…]]]. */
const nested = (n: number): unknown => {
  let v: unknown = 0;
  for (let i = 0; i < n; i++) v = [v];
  return v;
};
/** The same shape in the STRING half of the codec. */
const nestedLiteral = (n: number): string => "[".repeat(n) + "0" + "]".repeat(n);

const median = (xs: number[]): number => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

const PROVIDED = "events.iterate.com/capability-table/capability-provided";

// ═══════════════════════ expression/value depth near the parse budget ═══════════════════════

test("a 64-deep nested-array payload (structured lane) appends and reads back byte-identically", async () => {
  const itx = await harness.itx("prj_path_depth");
  const payload = { d: nested(64) }; // the value-depth budget is 64 — this is AT the edge
  const [committed] = await itx.invokeCapability({
    path: ["stream", "append"],
    args: [{ type: "deep", payload }],
  });
  expect(committed.offset).toBeGreaterThanOrEqual(1);
  const page = await itx.invokeCapability({
    path: ["stream", "read"],
    args: [committed.offset - 1, 1],
  });
  expect(page.events).toHaveLength(1);
  expect(JSON.stringify(page.events[0].payload)).toBe(JSON.stringify(payload));
});

test("string-half expressions: deeply nested payloads parse and round-trip (JSON5, no parse budget)", async () => {
  const itx = await harness.itx("prj_path_depthstr");
  // JSON5 is iterative — there is no artificial parse budget; a deep arg parses and round-trips.
  for (const depth of [58, 70]) {
    const [committed] = await itx.invoke(
      `itx.stream.append({type:'deepstr',payload:{d:${nestedLiteral(depth)}}})`,
    );
    const page = await itx.invokeCapability({
      path: ["stream", "read"],
      args: [committed.offset - 1, 1],
    });
    expect(JSON.stringify(page.events[0].payload)).toBe(JSON.stringify({ d: nested(depth) }));
  }
});

test("FIXED (defect 22): idempotent RETRY of a 64-deep payload dedupes's depth error instead of deduping", async () => {
  // BUG: the COMMIT path never deep-walks a payload (the 64-deep round trip above passes),
  //      but the DEDUPE path does — StreamEventLog.append → sameIdempotentEvent → jsonEqual,
  //      whose recursion spends the shared 64-level budget on the payload the log already
  //      holds. Verified against the real worker: the retry rejects with
  //      "equal: value nesting exceeds 64 levels" (thrown inside the DO's append transaction).
  // EXPECTED: same key + same body = the existing event comes back (the idempotency
  //      contract) — for ANY payload the stream was willing to commit in the first place.
  // ACTUAL: the first append succeeds; every retry under the same key throws — the exact
  //      retry the idempotency key exists to make safe is the only call that fails.
  // WHY IT MATTERS: idempotency keys are the crash-recovery story (processors re-append after
  //      a failed batch, clients re-send after a timeout). A payload near the depth budget
  //      turns that safety net into a poison pill: the retry lane errors forever while the
  //      event sits committed, so callers can neither confirm nor dedupe their own write.
  const itx = await harness.itx("prj_path_depthkey");
  const build = () => ({
    type: "deep-keyed",
    payload: { d: nested(64) },
    idempotencyKey: "deep-once",
  });
  const [first] = await itx.invokeCapability({ path: ["stream", "append"], args: [build()] });
  const [retry] = await itx.invokeCapability({ path: ["stream", "append"], args: [build()] });
  expect(retry.offset).toBe(first.offset); // the idempotency contract: same key + same body = same event
});

// ════════════════════════════════ a 300-row mount table ════════════════════════════════

test("300 mounts: invoking the NEWEST mount and a base config mount both stay under 150ms", async () => {
  const itx = await harness.itx("prj_path_mounts");
  // Mounts are event-sourced — append all 300 capability-provided events in ONE commit.
  const mounts = Array.from({ length: 300 }, (_, i) => ({
    type: PROVIDED,
    payload: { path: `itx.m${i}`, target: "itx.whoami" },
  }));
  const committed = await itx.invokeCapability({ path: ["stream", "append"], args: mounts });
  expect(committed).toHaveLength(300);

  const time = async (fn: () => Promise<unknown>, iters = 12): Promise<number> => {
    const samples: number[] = [];
    for (let i = 0; i < iters; i++) {
      const t0 = performance.now();
      await fn();
      samples.push(performance.now() - t0);
    }
    return median(samples);
  };

  // Warm both lanes once (table rehydration / DO wake are not what we are measuring).
  const viaNewest = await itx.invokeCapability({ path: ["m299"], args: [] });
  expect(viaNewest).toMatchObject({ projectId: "prj_path_mounts", path: "/" }); // it really aliases whoami
  await itx.invokeCapability({ path: ["whoami"], args: [] });

  const newestMs = await time(() => itx.invokeCapability({ path: ["m299"], args: [] }));
  const configMs = await time(() => itx.invokeCapability({ path: ["whoami"], args: [] }));
  // eslint-disable-next-line no-console
  console.log(
    `[300 mounts] newest-mount median ${newestMs.toFixed(1)}ms, config-mount median ${configMs.toFixed(1)}ms`,
  );
  expect(newestMs, `newest event mount (m299) median ${newestMs.toFixed(1)}ms`).toBeLessThan(150);
  expect(configMs, `base config mount (whoami) median ${configMs.toFixed(1)}ms`).toBeLessThan(150);
}, 90_000);

// ════════════════════════════ alias chains against the depth-32 budget ════════════════════════════

test("an alias chain 30 deep resolves under the depth-32 budget; 33 deep fails loudly", async () => {
  const itx = await harness.itx("prj_path_alias");
  // alias0 → itx.whoami; aliasK → itx.alias(K-1). One commit mounts all 33 rows.
  const aliases = Array.from({ length: 33 }, (_, i) => ({
    type: PROVIDED,
    payload: { path: `itx.alias${i}`, target: i === 0 ? "itx.whoami" : `itx.alias${i - 1}` },
  }));
  await itx.invokeCapability({ path: ["stream", "append"], args: aliases });

  // 30 hops (alias29 → … → alias0 → whoami) resolve within the budget…
  const resolved = await itx.invokeCapability({ path: ["alias29"], args: [] });
  expect(resolved).toMatchObject({ projectId: "prj_path_alias", path: "/" });

  // …33 hops trip the guard LOUDLY (never a spin, never a stack overflow).
  await expect(itx.invokeCapability({ path: ["alias32"], args: [] })).rejects.toThrow(/depth 32/);
}, 60_000);

// ══════════════════════════════ payload-size baseline control ══════════════════════════════

test("a ~256KB payload round-trips byte-identically (the in-bounds control)", async () => {
  const itx = await harness.itx("prj_path_mid");
  const blob = "x".repeat(256 * 1024);
  const [committed] = await itx.invokeCapability({
    path: ["stream", "append"],
    args: [{ type: "mid", payload: { blob } }],
  });
  const page = await itx.invokeCapability({
    path: ["stream", "read"],
    args: [committed.offset - 1, 1],
  });
  expect(page.events[0].payload.blob === blob).toBe(true);
});

// ═══════════ arbitrary-size payloads (row chunking — the apps/os contract) ═══════════
// The owner wants arbitrary-size event payloads via ROW CHUNKING, exactly like apps/os. The
// contract, extracted read-only from apps/os/src/domains/streams:
//   • stream-storage.ts:26 — EVENT_CHUNK_SIZE = 512 KiB: the serialized event JSON is split
//     into ≤512KiB byte rows IN JS, because DO SQLite caps every cell at ~2MB and BLOB
//     columns do not raise it (stream-storage.ts:4-9).
//   • stream-storage.ts:44-49 — `events` holds metadata/index only (offset PK, type,
//     created_at, idempotency_key UNIQUE); the full body lives in
//     `event_chunks(offset, chunk_index, chunk_bytes)`, PK (offset, chunk_index), FK
//     cascade to events (stream-storage.ts:54-61). Chunk rows are ADDRESSED BY the event's
//     offset — they never consume offsets; the allocator advances once per EVENT
//     (stream-storage.ts:160-167 + the stream_metadata floor at 62-70).
//   • Read reassembly re-joins chunks in (offset, chunk_index) order, validates contiguity
//     LOUDLY ("has no body" / "starts at body chunk N" / "missing body chunk" —
//     stream-storage.ts:241-259) and reproduces the exact inserted bytes (byteLength
//     equality proven in stream-storage.test.ts:94-116).
//   • Idempotency dedupe reassembles the FULL stored body (getByIdempotencyKey,
//     stream-storage.ts:177-185) and compares sameIdempotentEvent over it — including
//     same-batch hits (stream-durable-object.ts:2011, 2031-2061).
//   • Atomicity: every storage method is synchronous inside one event-loop task under the
//     DO output gate, and the FK cascade ties chunk rows to their event row — a mid-batch
//     throw persists nothing (stream-storage.ts:59, 762-766).
// Our worker instead stores one JSON TEXT cell per event and rejects big bodies at the
// SQLite cell cap with SQLITE_TOOBIG — a documented GAP against that contract. The 256KB
// control above is today's working baseline.

describe("arbitrary-size payloads (row chunking — the apps/os contract)", () => {
  const append = async (itx: any, events: unknown[]) =>
    itx.invokeCapability({ path: ["stream", "append"], args: events });
  const readOne = async (itx: any, offset: number) => {
    const page = await itx.invokeCapability({ path: ["stream", "read"], args: [offset - 1, 1] });
    return page.events[0];
  };

  test("a 5MB payload append commits and round-trip byte-identically", async () => {
    // BUG: StreamEventLog.append stores the whole serialized event as ONE SQLite TEXT cell;
    //      anything over the ~2MB cell cap rejects with "string or blob too big:
    //      SQLITE_TOOBIG" (verified on this harness) instead of being chunked.
    // EXPECTED (apps/os contract): the body is split into 512KiB chunk rows
    //      (stream-storage.ts:26,151-158); ANY committable JSON payload commits and reads
    //      back byte-identically regardless of size.
    // ACTUAL: the append rejects at ~2MB; 5MB is unstorable.
    // WHY IT MATTERS: apps/os processors and clients ported to this worker rely on
    //      arbitrary-size payloads (transcripts, model outputs, board dumps); today they
    //      hit a hard 2MB wall the port is contractually supposed to have removed.
    const itx = await harness.itx("prj_chunk_5mb");
    const blob = "y".repeat(5 * 1024 * 1024);
    const [committed] = await append(itx, [{ type: "big", payload: { blob } }]);
    expect(committed.offset).toBeGreaterThanOrEqual(1);
    const back = await readOne(await harness.itx("prj_chunk_5mb"), committed.offset);
    expect(back.type).toBe("big");
    expect(back.payload.blob === blob).toBe(true); // identity check — never a 5MB assertion diff
  }, 60_000);

  test("a 2MiB payload commits and round-trips — today's observed single-cell headroom (boundary control)", async () => {
    // OBSERVED (workerd-local, wrangler 4.107.0): a 2MiB blob (+ JSON envelope) still fits
    //      one SQLite cell and round-trips; 3MiB does not (SQLITE_TOOBIG — the test below).
    //      Today's hard boundary therefore sits between 2MiB and 3MiB of payload. Pinned
    //      plain so a silent boundary change shows up as a test flip.
    const itx = await harness.itx("prj_chunk_2mb");
    const blob = "z".repeat(2 * 1024 * 1024);
    const [committed] = await append(itx, [{ type: "mid-big", payload: { blob } }]);
    const back = await readOne(itx, committed.offset);
    expect(back.payload.blob === blob).toBe(true);
  }, 60_000);

  test("a just-over-the-cell-cap (3MiB) payload commits and round-trip", async () => {
    // BUG: same root cause as the 5MB case — this pins the boundary: 2MiB commits (control
    //      above), 3MiB rejects with "string or blob too big: SQLITE_TOOBIG", so the first
    //      thing chunking must handle is a ~3MiB body (≈6 of apps/os's 512KiB chunk rows —
    //      stream-storage.ts:26).
    // EXPECTED (apps/os contract): commits and reads back byte-identically.
    // ACTUAL: SQLITE_TOOBIG rejection.
    // WHY IT MATTERS: ~3MB is not pathological in practice (one long model transcript);
    //      the failure boundary sits INSIDE normal product traffic, not beyond it.
    const itx = await harness.itx("prj_chunk_3mb");
    const blob = "z".repeat(3 * 1024 * 1024);
    const [committed] = await append(itx, [{ type: "mid-big", payload: { blob } }]);
    const back = await readOne(itx, committed.offset);
    expect(back.payload.blob === blob).toBe(true);
  }, 60_000);

  test("offsets stay dense around a chunked event — the NEXT event is exactly +1", async () => {
    // BUG: unassertable today — the big append in the middle rejects (SQLITE_TOOBIG).
    // EXPECTED (apps/os contract): a chunked event is ONE event at ONE offset; its chunk
    //      rows are addressed by (offset, chunk_index) and never touch the allocator
    //      (stream-storage.ts:54-61,160-167). So small(N), big(N+1), small(N+2) — dense —
    //      and the big offset holds exactly one event carrying the whole body.
    // ACTUAL: the middle append rejects; nothing to page.
    // WHY IT MATTERS: this assertion is what separates REAL row chunking from the cheap
    //      workaround (splitting one payload across multiple events): multi-event splitting
    //      would burn extra offsets between the neighbors and return >1 event for the body.
    const itx = await harness.itx("prj_chunk_dense");
    const blob = "d".repeat(3 * 1024 * 1024);
    const [before] = await append(itx, [{ type: "small-before" }]);
    const committedBig = await append(itx, [{ type: "big", payload: { blob } }]);
    expect(committedBig).toHaveLength(1); // ONE event committed for one input — not split
    const [after] = await append(itx, [{ type: "small-after" }]);
    expect(committedBig[0].offset).toBe(before.offset + 1); // dense…
    expect(after.offset).toBe(committedBig[0].offset + 1); // …on both sides
    // The big offset alone carries the WHOLE body (chunk rows are invisible to reads):
    const page = await itx.invokeCapability({
      path: ["stream", "read"],
      args: [before.offset, 500],
    });
    expect(page.events.map((e: { type: string }) => e.type)).toEqual(["big", "small-after"]);
    expect(page.events[0].payload.blob === blob).toBe(true);
  }, 60_000);

  test("an idempotent RETRY of a large chunked payload dedupes to the same offset", async () => {
    // BUG: unassertable today — the first large append already rejects (SQLITE_TOOBIG).
    // EXPECTED (apps/os contract): dedupe reassembles the FULL stored body from its chunk
    //      rows (getByIdempotencyKey, stream-storage.ts:177-185) and compares it
    //      structurally (stream-durable-object.ts:2031-2061) — so a retry of a committed
    //      large event returns the SAME offset, and the body reads back once,
    //      byte-identically.
    // ACTUAL: nothing large ever commits, so the retry lane for large bodies is untestable
    //      end to end.
    // WHY IT MATTERS: idempotent re-append after a timeout is exactly when payloads are
    //      large (the caller retries BECAUSE the big write was slow); chunked dedupe is the
    //      difference between one event and a duplicate pair.
    const itx = await harness.itx("prj_chunk_idem");
    const blob = "k".repeat(3 * 1024 * 1024);
    const build = () => ({ type: "big-keyed", payload: { blob }, idempotencyKey: "big-once" });
    const [first] = await append(itx, [build()]);
    const [retry] = await append(itx, [build()]);
    expect(retry.offset).toBe(first.offset); // dedupe, not a duplicate
    const back = await readOne(itx, first.offset);
    expect(back.payload.blob === blob).toBe(true);
  }, 60_000);

  test("a chunked append followed by an idempotency CONFLICT in the same batch rolls back ALL chunk rows", async () => {
    // BUG: unassertable today — the batch dies on SQLITE_TOOBIG at the big event, BEFORE
    //      the conflict is even evaluated, so the rejection carries the wrong error.
    // EXPECTED (apps/os contract): the batch reaches the conflicting input and rejects
    //      with the IDEMPOTENCY_CONFLICT error; the big event's already-written chunk rows
    //      roll back with the events row in the same synchronous transaction
    //      (stream-storage.ts:59 FK cascade + 762-766 one-task atomicity) — afterwards the
    //      log shows nothing partial and the next append lands at the next dense offset.
    // ACTUAL: rejects with "string or blob too big: SQLITE_TOOBIG" instead.
    // WHY IT MATTERS: chunk rows are the first multi-row write in the commit path; a torn
    //      mid-batch failure that leaves orphan chunk rows (or half a body) is the new
    //      corruption class chunking introduces — the rollback MUST be provably whole.
    const itx = await harness.itx("prj_chunk_rollback");
    const [pin] = await append(itx, [{ type: "pin", payload: { v: 1 }, idempotencyKey: "pin" }]);
    const blob = "r".repeat(3 * 1024 * 1024);
    await expect(
      append(itx, [
        { type: "big-victim", payload: { blob } },
        { type: "pin", payload: { v: 2 }, idempotencyKey: "pin" }, // same key, DIFFERENT body → conflict
      ]),
    ).rejects.toThrow(/idempotency key "pin" already names a different event/);
    // Nothing partial survived the rollback…
    const page = await itx.invokeCapability({ path: ["stream", "read"], args: [0, 500] });
    expect(page.events.map((e: { type: string }) => e.type)).toEqual(["pin"]);
    // …and the allocator did not burn offsets for the rolled-back batch: dense continuation.
    const [next] = await append(itx, [{ type: "after-rollback" }]);
    expect(next.offset).toBe(pin.offset + 1);
  }, 60_000);

  test("read paging across a chunked event keeps the scanned-offset-range proof honest", async () => {
    // BUG: unassertable today — the chunked event in the middle cannot commit.
    // EXPECTED (apps/os contract): chunk rows are invisible to paging — a limit-N page
    //      counts EVENTS, its scannedThroughOffset is the last EVENT row's offset when the
    //      page is full (never a chunk boundary), and consecutive pages chain contiguously
    //      with the chunked body intact in whichever page holds it.
    // ACTUAL: the setup append rejects (SQLITE_TOOBIG).
    // WHY IT MATTERS: every processor cursor and gap repair in this codebase trusts the
    //      scanned-offset-range proof; if chunk rows ever leaked into the page arithmetic,
    //      cursors would advance to phantom offsets and repairs would skip real events.
    const itx = await harness.itx("prj_chunk_paging");
    const blob = "p".repeat(3 * 1024 * 1024);
    await append(itx, [{ type: "e1" }, { type: "e2" }]);
    const [big] = await append(itx, [{ type: "big", payload: { blob } }]); // offset 3
    await append(itx, [{ type: "e4" }, { type: "e5" }]);
    // Page 1: limit 3 lands exactly ON the chunked event.
    const page1 = await itx.invokeCapability({ path: ["stream", "read"], args: [0, 3] });
    expect(page1.events.map((e: { offset: number }) => e.offset)).toEqual([1, 2, 3]);
    expect(page1.scannedThroughOffset).toBe(big.offset); // the EVENT offset — never a chunk row's
    expect(page1.events[2].payload.blob === blob).toBe(true); // the body rode the page whole
    // Page 2 chains contiguously from the proof.
    const page2 = await itx.invokeCapability({
      path: ["stream", "read"],
      args: [page1.scannedThroughOffset, 500],
    });
    expect(page2.events.map((e: { offset: number }) => e.offset)).toEqual([4, 5]);
    expect(page2.scannedThroughOffset).toBe(5);
  }, 60_000);
});

// ══════════════════════════ 50 processors fan-out on one stream ══════════════════════════

const FAN_PROCESSOR_SOURCE = /* js */ `
import { StreamProcessor } from "./processor.js";
export default class FanProbe extends StreamProcessor {
  contract = {
    slug: "fan-probe",
    version: "1",
    description: "counts every durable event — the fan-out probe",
    consumes: ["*"],
    emits: [],
    initialState: () => ({ n: 0 }),
  };
  reduce({ state }) {
    return { n: state.n + 1 };
  }
}
`;

test.fails("BUG: 50 userspace processors — the loader lane cannot materialize AT ALL under the local harness", async () => {
  // BUG: confinedWorker (core/agent-runtime.ts) sets compatibilityFlags:
  //      ["allow_irrevocable_stub_storage"] on every LOADER.get worker; local workerd (as
  //      booted by wrangler createTestHarness) refuses experimental flags without
  //      --experimental, so the very FIRST enableProcessor with a userspace ref rejects:
  //      "The compatibility flag allow_irrevocable_stub_storage is experimental … you must
  //      pass --experimental". TestHarnessOptions exposes no knob for it ({root, workers}
  //      only — checked wrangler 4.107.0), so the whole userspace-processor lane is
  //      untestable in the one lane that boots the real worker.
  // EXPECTED: 50 userspace processors enable, one append fans out to all 50 in <5s, and the
  //      stream stays responsive while it happens (the assertions below — they become live
  //      the moment the harness can boot workerd with --experimental or the flag goes stable).
  // ACTUAL: enableProcessor("fan0", …) throws at facet materialization; zero of the 50 enable.
  // WHY IT MATTERS: the harness exists so "tests speak to it exactly like production
  //      clients" — but the loader path (userspace processors, code caps, stateful workers)
  //      is invisible to it, which is exactly where pathological fan-out and isolate-cost
  //      bugs live. Until this gap closes, no CI lane can catch a fan-out regression.
  //      (The loader-free fan-out probe below covers the commit-path half in the meantime.)
  const itx = await harness.itx("prj_path_fanout");
  await itx.invokeCapability({ path: ["kv", "put"], args: ["procsrc", FAN_PROCESSOR_SOURCE] });

  const enableT0 = performance.now();
  for (let i = 0; i < 50; i++) {
    await itx.enableProcessor(`fan${i}`, { source: "itx.kv.get('procsrc')", className: "default" });
  }
  const enableMs = performance.now() - enableT0;
  // eslint-disable-next-line no-console
  console.log(`[fan-out] enabled 50 userspace processors in ${enableMs.toFixed(0)}ms`);

  // ONE append → the pump drives all 50 facets.
  const t0 = performance.now();
  const [marker] = await itx.invokeCapability({
    path: ["stream", "append"],
    args: [{ type: "fanout-marker" }],
  });

  // Responsiveness DURING the fan-out: an unrelated call must not be head-of-line blocked.
  const whoT0 = performance.now();
  await itx.invokeCapability({ path: ["whoami"], args: [] });
  const whoMs = performance.now() - whoT0;

  // The barrier: every one of the 50 processors reaches the marker offset.
  await Promise.all(
    Array.from({ length: 50 }, (_, i) =>
      itx.invoke(
        `itx.facets.get('fan${i}').waitUntilProcessed({offset: ${marker.offset}, timeoutMs: 30000})`,
      ),
    ),
  );
  const fanoutMs = performance.now() - t0;
  // eslint-disable-next-line no-console
  console.log(
    `[fan-out] all 50 processors reached offset ${marker.offset} in ${fanoutMs.toFixed(0)}ms; whoami during fan-out ${whoMs.toFixed(1)}ms`,
  );

  // Sanity: a mid-pack processor really reduced the log (each enable event + the marker).
  const snap = await itx.invoke(`itx.subscribers.fan7.snapshot()`);
  expect(snap.offset).toBeGreaterThanOrEqual(marker.offset);
  expect((snap.state as { n: number }).n).toBeGreaterThan(0);

  expect(fanoutMs, `fan-out wall time ${fanoutMs.toFixed(0)}ms`).toBeLessThan(5000);
  expect(whoMs, `whoami during fan-out ${whoMs.toFixed(1)}ms`).toBeLessThan(1500);
}, 240_000);

test("50 CONNECTED live subscribers: one append fans out to all 50 in <5s and the stream stays responsive (the loader-free fan-out lane)", async () => {
  // The commit-path half of the fan-out story (the loader half is blocked — see the BUG test
  // above): 50 live capnweb callbacks parked as ItxConnections, delivered fire-and-forget
  // from the commit path. Wall time = append → the LAST subscriber sees the marker.
  const itx = await harness.itx("prj_path_subfan");
  const timers: ReturnType<typeof setTimeout>[] = [];
  const waiters: Promise<number>[] = [];
  const subscribeT0 = performance.now();
  for (let i = 0; i < 50; i++) {
    let sawMarker!: (atMs: number) => void;
    waiters.push(
      new Promise<number>((resolve, reject) => {
        sawMarker = resolve;
        timers.push(
          setTimeout(
            () => reject(new Error(`subscriber ${i} never saw the marker in 30s`)),
            30_000,
          ),
        );
      }),
    );
    // A live function target: parked as an anonymous ItxConnection, served on the connected
    // lane — each committed batch arrives as (events, scannedOffsetRange).
    const target = (events: { type: string }[], _range: unknown) => {
      if (events.some((e) => e.type === "sub-fanout-marker")) sawMarker(performance.now());
    };
    await itx.subscribe({ name: `sub${i}`, target });
  }
  const subscribeMs = performance.now() - subscribeT0;

  const t0 = performance.now();
  await itx.invokeCapability({ path: ["stream", "append"], args: [{ type: "sub-fanout-marker" }] });

  // Responsiveness DURING the fan-out: an unrelated call must not be head-of-line blocked.
  const whoT0 = performance.now();
  await itx.invokeCapability({ path: ["whoami"], args: [] });
  const whoMs = performance.now() - whoT0;

  let lastArrival: number;
  try {
    lastArrival = Math.max(...(await Promise.all(waiters)));
  } finally {
    for (const t of timers) clearTimeout(t);
  }
  const fanoutMs = lastArrival - t0;
  // eslint-disable-next-line no-console
  console.log(
    `[sub fan-out] 50 subscribes in ${subscribeMs.toFixed(0)}ms; marker reached all 50 in ${fanoutMs.toFixed(0)}ms; whoami during fan-out ${whoMs.toFixed(1)}ms`,
  );
  expect(fanoutMs, `connected fan-out wall time ${fanoutMs.toFixed(0)}ms`).toBeLessThan(5000);
  expect(whoMs, `whoami during fan-out ${whoMs.toFixed(1)}ms`).toBeLessThan(1500);
}, 240_000);
