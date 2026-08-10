// Facet-hosted processor integration suite: the REAL ProcessorFacet + registry
// + runner + DO durability adapters inside a real workerd facet, driven from
// the plain-Node unit lane via programmatic Miniflare (the pinned catalog
// version — no @cloudflare/vitest-pool-workers, per docs/testing.md
// principle 6). The worker under test is esbuild-bundled from
// processor-facet.test-worker.ts at suite start.
//
// Scenarios (ported from the facet proof, the platform oracle):
//   R1 progress-in-facet (NAME-keyed) + abort survival + doors
//   R2 wake across the facet hop + per-batch reportDeliveryResult settlement
//   R3 redelivery correctness: no double effects for committed events
//   R4 parent-owned alarm proxy drives keepalive revival (real platform alarm)
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { StreamEvent } from "./schemas.ts";

// Mirrors of the worker's constants — the worker module cannot be imported
// here (its `cloudflare:workers` import only resolves inside workerd), so the
// suite pins the literals and the worker's own assertions keep them honest.
const FACET_TEST_SLUG = "facet-proof";
// One identity: the subscription name IS the contract slug.
const FACET_TEST_SUBSCRIPTION_NAME = FACET_TEST_SLUG;
const REVIVED_TYPE = "events.iterate.com/stream/processor-revived";

let mf: Miniflare;

beforeAll(async () => {
  // In-tree, not os.tmpdir(): workerd refuses module paths that `..` out of
  // its starting directory.
  const bundleDir = fileURLToPath(
    new URL("../../node_modules/.cache/processor-facet-test", import.meta.url),
  );
  mkdirSync(bundleDir, { recursive: true });
  const outfile = join(bundleDir, "worker.mjs");
  await build({
    entryPoints: [fileURLToPath(new URL("./processor-facet.test-worker.ts", import.meta.url))],
    bundle: true,
    format: "esm",
    outfile,
    external: ["cloudflare:workers"],
    logLevel: "silent",
  });
  mf = new Miniflare({
    modules: true,
    scriptPath: outfile,
    // Exactly apps/os production compat (scripts/generate-wrangler-config.ts).
    compatibilityDate: "2026-07-01",
    compatibilityFlags: ["nodejs_compat", "global_fetch_strictly_public"],
    durableObjects: {
      PARENT: { className: "FacetTestParent", useSQLite: true },
    },
  });
  await mf.ready;
}, 120_000);

afterAll(async () => {
  await mf?.dispose();
});

/** Drive one parent verb through the worker's HTTP door. Every call is its own
 * request → its own parent RPC turn, so cross-turn retention is real. */
async function invoke<T = any>(run: string, verb: string, args?: unknown): Promise<T> {
  const res = await mf.dispatchFetch("http://proof/invoke", {
    method: "POST",
    body: JSON.stringify({ run, verb, args }),
  });
  const body = (await res.json()) as { ok: boolean; result?: T; error?: string };
  if (!body.ok) throw new Error(`${verb} failed: ${body.error}`);
  return body.result as T;
}

describe("ProcessorFacet in real workerd (Miniflare)", () => {
  test(
    "R1: registry+runner+progress run in the facet; NAME-keyed progress survives abort; doors serve reads",
    { timeout: 60_000 },
    async () => {
      const run = "r1";
      await invoke(run, "configureFacet");
      const seeded = await invoke<StreamEvent[]>(run, "facetSeed", {
        events: [
          { type: "test/noted", payload: { note: "a" } },
          { type: "test/noted", payload: { note: "b" } },
        ],
      });
      expect(seeded.map((event) => event.offset)).toEqual([1, 2]);

      const wake1 = await invoke(run, "wake");
      expect(wake1.checkpointOffset).toBe(0);
      expect(wake1.openedBy?.processor?.announcement?.slug).toBe(FACET_TEST_SLUG);
      // The wake response's getRuntimeState capability answered across the hop.
      expect(wake1.runtimeState?.snapshot).toBeDefined();

      const delivered = await invoke(run, "deliver", {
        events: seeded,
        scannedAfterOffset: 0,
        scannedThroughOffset: 2,
        streamMaxOffset: 2,
      });
      expect(delivered).toEqual({ outcome: "ok" });

      // Progress keyed by the subscription name (= contract slug — one
      // identity), in the FACET's own kv.
      const proof1 = await invoke(run, "facetReadProof");
      expect(proof1.progressKey).toBe(`stream-processor:${FACET_TEST_SUBSCRIPTION_NAME}:progress`);
      expect(proof1.progress?.streamId).toBe("11111111-1111-4111-8111-111111111111");
      expect(proof1.progress?.processing?.acknowledgedThroughOffset).toBe(2);
      expect(proof1.progress?.reduction?.state).toMatchObject({ count: 2, lastNote: "b" });

      // Negative evidence: nothing under that key in the PARENT's storage.
      const parentKv = await invoke(run, "readParentKv", { key: proof1.progressKey });
      expect(parentKv.value).toBeNull();

      // Abort the facet incarnation; storage (and the committed progress) survive.
      await invoke(run, "abortFacet");
      const proof2 = await invoke(run, "facetReadProof");
      expect(proof2.progress).toEqual(proof1.progress);

      // The doors on a fresh incarnation reload the committed fold.
      const snapshot = await invoke(run, "facetSnapshot");
      expect(snapshot).toMatchObject({ offset: 2, state: { count: 2, lastNote: "b" } });
      const runtimeState = await invoke(run, "facetRuntimeState");
      expect(runtimeState.snapshot).toMatchObject({ offset: 2, state: { count: 2 } });
      const live = await invoke(run, "facetLiveGet");
      expect(live).toMatchObject({ count: 2, lastNote: "b" });

      // Re-wake resumes at the committed checkpoint.
      const wake2 = await invoke(run, "wake");
      expect(wake2.checkpointOffset).toBe(2);

      // Both side-effect lanes ran exactly once per event; the emitted appends
      // landed on the stream with processor provenance.
      const effects: string[] = proof2.effectLog;
      expect(effects.filter((entry) => entry.startsWith("blocking:"))).toHaveLength(2);
      expect(effects.filter((entry) => entry.startsWith("background:"))).toHaveLength(2);
      const stream = await invoke(run, "facetStreamInfo");
      const recorded = stream.events.filter(
        (event: StreamEvent) => event.type === "test/effect-recorded",
      );
      expect(recorded).toHaveLength(2);
      expect(
        recorded.every((event: StreamEvent) => event.source?.processor?.slug === FACET_TEST_SLUG),
      ).toBe(true);
    },
  );

  test(
    "R2: retained processEventBatch delivers successive batches across turns; per-batch settlement",
    { timeout: 60_000 },
    async () => {
      const run = "r2";
      await invoke(run, "configureFacet");
      const seeded = await invoke<StreamEvent[]>(run, "facetSeed", {
        events: ["a", "b", "c"].map((note) => ({ type: "test/noted", payload: { note } })),
      });
      const wake = await invoke(run, "wake");
      expect(wake.checkpointOffset).toBe(0);

      let expectedAck = 0;
      for (const event of seeded) {
        // Each deliver is its own HTTP request → its own parent RPC turn; the
        // callback used is the stub retained (dup'd) in the wake turn, and
        // each batch's completion arrives through its own independent
        // argument-direction reportDeliveryResult capability.
        const result = await invoke(run, "deliver", {
          events: [event],
          scannedAfterOffset: expectedAck,
          scannedThroughOffset: event.offset,
          streamMaxOffset: seeded.at(-1)!.offset,
        });
        expect(result).toEqual({ outcome: "ok" });
        const proof = await invoke(run, "facetReadProof");
        // The runner commits once per delivered batch.
        expect(proof.progress.processing.acknowledgedThroughOffset).toBe(event.offset);
        expectedAck = event.offset;
      }
      const proof = await invoke(run, "facetReadProof");
      const blocking = proof.effectLog.filter((entry: string) => entry.startsWith("blocking:"));
      expect(blocking).toHaveLength(3);
    },
  );

  test(
    "R3: redelivery after a mid-batch abort re-runs only uncommitted events; appends dedupe",
    { timeout: 60_000 },
    async () => {
      const run = "r3";
      await invoke(run, "configureFacet");
      const [e1] = await invoke<StreamEvent[]>(run, "facetSeed", {
        events: [{ type: "test/noted", payload: { note: "x" } }],
      });
      await invoke(run, "wake");
      const d1 = await invoke(run, "deliver", {
        events: [e1],
        scannedAfterOffset: 0,
        scannedThroughOffset: e1!.offset,
        streamMaxOffset: e1!.offset,
      });
      expect(d1).toEqual({ outcome: "ok" });

      // Arm the hang and deliver a batch whose commit can never land.
      await invoke(run, "facetArmHang");
      const seeded = await invoke<StreamEvent[]>(run, "facetSeed", {
        events: [
          { type: "test/noted", payload: { note: "y" } },
          { type: "test/hang-requested", payload: {} },
        ],
      });
      const [eY, eHang] = seeded;
      let info = await invoke(run, "facetStreamInfo", { includeEvents: false });
      const d2 = await invoke(run, "deliver", {
        events: [eY, eHang],
        scannedAfterOffset: e1!.offset,
        scannedThroughOffset: eHang!.offset,
        streamMaxOffset: info.maxOffset,
        timeoutMs: 1500,
      });
      expect(d2).toEqual({ outcome: "timeout" });

      let proof = await invoke(run, "facetReadProof");
      // The commit did NOT land: cursor still at batch-1 acknowledgement.
      expect(proof.progress.processing.acknowledgedThroughOffset).toBe(e1!.offset);
      expect(
        proof.effectLog.filter((entry: string) => entry === `blocking:y@${eY!.offset}`),
      ).toHaveLength(1);

      await invoke(run, "abortFacet", { reason: "mid-blocker abort" });

      // Re-wake resumes from the acknowledged cursor — redelivery required.
      const wake2 = await invoke(run, "wake");
      expect(wake2.checkpointOffset).toBe(e1!.offset);

      info = await invoke(run, "facetStreamInfo", { includeEvents: false });
      const d3 = await invoke(run, "deliver", {
        events: [eY, eHang],
        scannedAfterOffset: e1!.offset,
        scannedThroughOffset: eHang!.offset,
        streamMaxOffset: info.maxOffset,
      });
      expect(d3).toEqual({ outcome: "ok" });

      proof = await invoke(run, "facetReadProof");
      expect(proof.progress.processing.acknowledgedThroughOffset).toBe(eHang!.offset);
      // COMMITTED event x never re-ran; uncommitted y re-ran exactly once more
      // (at-least-once), and its stream append deduped by idempotency key.
      expect(
        proof.effectLog.filter((entry: string) => entry === `blocking:x@${e1!.offset}`),
      ).toHaveLength(1);
      expect(
        proof.effectLog.filter((entry: string) => entry === `blocking:y@${eY!.offset}`),
      ).toHaveLength(2);
      const stream = await invoke(run, "facetStreamInfo");
      const yEffects = stream.events.filter(
        (event: StreamEvent) =>
          event.type === "test/effect-recorded" && (event.payload as { note: string }).note === "y",
      );
      expect(yEffects).toHaveLength(1);

      // Post-commit redelivery is a clean ack with ZERO new effects (offset dedupe).
      const d4 = await invoke(run, "deliver", {
        events: [eY, eHang],
        scannedAfterOffset: e1!.offset,
        scannedThroughOffset: eHang!.offset,
        streamMaxOffset: info.maxOffset,
      });
      expect(d4).toEqual({ outcome: "ok" });
      const proofAfter = await invoke(run, "facetReadProof");
      expect(proofAfter.effectLog).toEqual(proof.effectLog);
    },
  );

  test(
    "R4: parent-owned alarm proxy revives the facet's keepalive obligation",
    { timeout: 90_000 },
    async () => {
      const run = "r4";
      await invoke(run, "configureFacet");
      const [e1] = await invoke<StreamEvent[]>(run, "facetSeed", {
        events: [{ type: "test/bg-requested", payload: {} }],
      });
      await invoke(run, "wake");
      const d1 = await invoke(run, "deliver", {
        events: [e1],
        scannedAfterOffset: 0,
        scannedThroughOffset: e1!.offset,
        streamMaxOffset: e1!.offset,
      });
      // The batch commits while the background obligation stays in flight.
      expect(d1).toEqual({ outcome: "ok" });

      const proof1 = await invoke(run, "facetReadProof");
      expect(typeof proof1.keepalive?.armedAtMs).toBe("number");
      const evidence1 = await invoke(run, "parentEvidence");
      // The facet's alarm desire crossed the proxy onto the PARENT's real
      // platform alarm.
      expect(evidence1.platformAlarm).toBe(proof1.keepalive.armedAtMs);

      // Die owing the background work.
      await invoke(run, "abortFacet", { reason: "die owing background work" });

      // The platform alarm (keepalive lead = 10s) fires in the parent, which
      // replays it into a FRESH facet incarnation's handleAlarm. That call
      // reentrantly dials proxySetAlarm on this parent while the parent is
      // still awaiting handleAlarm — the replay door must tolerate it.
      let fired: { alarmFires: unknown[]; log: string[] } | undefined;
      const deadline = Date.now() + 45_000;
      while (Date.now() < deadline) {
        const evidence = await invoke(run, "parentEvidence");
        if (
          evidence.alarmFires.length > 0 &&
          evidence.log.some((line: string) =>
            line.includes("alarm replayed into facet.handleAlarm OK"),
          )
        ) {
          fired = evidence;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      expect(fired, "parent alarm fired and was replayed into facet.handleAlarm").toBeDefined();

      const proof2 = await invoke(run, "facetReadProof");
      expect(proof2.keepalive?.revivals).toBeGreaterThanOrEqual(1);

      const stream = await invoke(run, "facetStreamInfo");
      const revived = stream.events.filter((event: StreamEvent) => event.type === REVIVED_TYPE);
      expect(revived.length).toBeGreaterThanOrEqual(1);
      // The revival fact names the CONTRACT in its payload while its
      // idempotency key carries the registered NAME.
      expect(revived[0]!.payload).toMatchObject({ processorSlug: FACET_TEST_SLUG });
      expect(revived[0]!.idempotencyKey).toContain(
        `processor-revived:${FACET_TEST_SUBSCRIPTION_NAME}@`,
      );
    },
  );
});
