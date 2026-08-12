// The MediaProcessor's server-side analysis obligations, driven through the
// real runner + keepalive over an in-memory stream (makeProcessorHarness).
// The durable story under test: media/uploaded opens an obligation, ONE
// media/processed event settles it (error field = the result union), and
// evictions/expiry/replay never lose an item or re-dial the vendor.
import { expect, test } from "vitest";
import { makeMemoryProgressStore, makeProcessorHarness } from "../../processors/testing.ts";
import type { HarnessProcessorDeps } from "../../processors/testing.ts";
import type { MediaAnalysisResult } from "./analysis.ts";
import { MediaProcessor, MediaProcessorContract, MEDIA_ANALYSIS_EXPIRY_MS } from "./processor.ts";

const PROCESSED = "events.iterate.com/media/processed";

test("uploaded opens an obligation; analysis settles it with one processed event", async () => {
  const h = makeHarness(async () => result({ title: "Trenitalia ticket", tags: ["logistics"] }));
  await h.append(uploaded("k1"));

  expect(h.events(PROCESSED)).toMatchObject([
    {
      idempotencyKey: "media/analysis-settled@k1:1",
      payload: { stableKey: "k1", title: "Trenitalia ticket", error: null, requestOffset: 1 },
    },
  ]);
  expect(h.state()).toMatchObject({
    items: {
      k1: {
        title: "Trenitalia ticket",
        markdown: "A train ticket.",
        tags: ["logistics"],
        analysisError: null,
        // file facts from the uploaded event survive the overlay
        filename: "shot.png",
        path: "/media/k1-shot.png",
      },
    },
    pendingAnalyses: {},
  });
});

test("a transient vendor failure is retried in-attempt and still succeeds", async () => {
  let calls = 0;
  const h = makeHarness(async () => {
    calls += 1;
    if (calls === 1) throw new Error("8005: Internal server error");
    return result({ title: "second try" });
  });
  await h.append(uploaded("k1"));
  // First try failed; the retry sleeps on virtual time.
  expect(h.events(PROCESSED)).toEqual([]);
  await h.advanceTime(2_000);

  expect(calls).toBe(2);
  expect(h.events(PROCESSED)).toMatchObject([{ payload: { title: "second try", error: null } }]);
});

test("terminal failure settles with an error and KEEPS the row", async () => {
  const h = makeHarness(async () => {
    throw new Error("8005: Internal server error");
  });
  await h.append(uploaded("k1"));
  await h.advanceTime(2_000); // try 2
  await h.advanceTime(8_000); // try 3 — terminal

  expect(h.events(PROCESSED)).toMatchObject([
    { payload: { stableKey: "k1", error: "8005: Internal server error", requestOffset: 1 } },
  ]);
  expect(h.state()).toMatchObject({
    items: { k1: { filename: "shot.png", analysisError: "8005: Internal server error" } },
    pendingAnalyses: {},
  });
});

test("eviction mid-attempt: the keepalive revival restarts the obligation", async () => {
  let calls = 0;
  const h = makeHarness(async () => {
    calls += 1;
    // The first incarnation's attempt hangs forever (vendor never answers).
    if (calls === 1) return await new Promise<never>(() => {});
    return result({ title: "after revival" });
  });
  await h.append(uploaded("k1"));
  expect(h.events(PROCESSED)).toEqual([]);

  h.crash();
  // The parked keepalive alarm fires, appends the revival fact, and the
  // caught-up pass finds the still-open obligation with an empty live-set.
  await h.advanceTime(60_000);

  expect(calls).toBe(2);
  expect(h.events(PROCESSED)).toMatchObject([{ payload: { title: "after revival", error: null } }]);
  expect(h.state()).toMatchObject({ pendingAnalyses: {} });
});

test("an expired obligation settles as failed without dialing the vendor", async () => {
  let calls = 0;
  const h = makeHarness(async () => {
    calls += 1;
    throw new Error("must never be dialed");
  });
  // Commit without driving delivery, then wake past the horizon — the
  // delivery-time state sees an already-expired request.
  await h.stream.append(uploaded("k1"));
  await h.advanceTime(MEDIA_ANALYSIS_EXPIRY_MS + 60_000);

  expect(calls).toBe(0);
  expect(h.events(PROCESSED)).toMatchObject([
    { payload: { stableKey: "k1", error: expect.stringContaining("expired") } },
  ]);
  expect(h.state()).toMatchObject({
    items: { k1: { analysisError: expect.stringContaining("expired") } },
    pendingAnalyses: {},
  });
});

test("reanalyze-requested re-runs analysis and overlays the newer result", async () => {
  let calls = 0;
  const h = makeHarness(async () => {
    calls += 1;
    return result({ title: `analysis ${calls}`, tags: calls === 1 ? [] : ["receipt"] });
  });
  await h.append(uploaded("k1"));
  await h.append({
    type: "events.iterate.com/media/reanalyze-requested",
    idempotencyKey: "media-reanalyze-k1-n1",
    payload: { stableKey: "k1" },
  });

  expect(calls).toBe(2);
  expect(h.events(PROCESSED)).toMatchObject([
    { payload: { title: "analysis 1" } },
    { payload: { title: "analysis 2", tags: ["receipt"] } },
  ]);
  expect(h.state()).toMatchObject({
    items: { k1: { title: "analysis 2", tags: ["receipt"] } },
    pendingAnalyses: {},
  });
});

test("a failed reanalyze keeps the earlier successful fields; only the error lands", async () => {
  let calls = 0;
  const h = makeHarness(async () => {
    calls += 1;
    if (calls === 1) return result({ title: "first success", tags: ["logistics"] });
    throw new Error("8005: Internal server error");
  });
  await h.append(uploaded("k1"));
  await h.append({
    type: "events.iterate.com/media/reanalyze-requested",
    idempotencyKey: "media-reanalyze-k1-n1",
    payload: { stableKey: "k1" },
  });
  await h.advanceTime(2_000); // retry 2
  await h.advanceTime(8_000); // retry 3 — terminal

  expect(h.events(PROCESSED)).toMatchObject([
    { payload: { title: "first success", error: null } },
    { payload: { error: "8005: Internal server error" } },
  ]);
  // The failure only contributes analysisError — the successful content
  // fields survive (the phone's deriveMediaList mirrors this).
  expect(h.state()).toMatchObject({
    items: {
      k1: {
        title: "first success",
        tags: ["logistics"],
        analysisError: "8005: Internal server error",
      },
    },
    pendingAnalyses: {},
  });
});

test("an uploaded event for a legacy-captured stableKey folds to a no-op (no re-analysis)", async () => {
  let calls = 0;
  const h = makeHarness(async () => {
    calls += 1;
    throw new Error("must never be dialed");
  });
  await h.append({
    type: "events.iterate.com/media/captured",
    idempotencyKey: "media-captured-k1",
    payload: {
      stableKey: "k1",
      path: "/media/k1-shot.png",
      filename: "shot.png",
      contentType: "image/png",
      width: 100,
      height: 200,
      source: "picker",
      capturedAt: null,
      isScreenshot: null,
      title: "already analyzed inline",
      markdown: "Legacy capture.",
      transcript: "",
      tags: ["screenshot"],
      processedBy: "legacy-model",
    },
  });
  // The shared idempotency-key scheme already rejects a same-key re-upload
  // at the stream door; this exercises the fold's defense in depth for an
  // uploaded event that lands under a different key (e.g. a raw append).
  await h.append({ ...uploaded("k1"), idempotencyKey: "media-captured-k1-raw" });

  expect(calls).toBe(0);
  expect(h.events(PROCESSED)).toEqual([]);
  expect(h.state()).toMatchObject({
    items: { k1: { title: "already analyzed inline" } },
    pendingAnalyses: {},
  });
});

test("re-uploading an analyzed stableKey after a wipe opens a FRESH obligation and re-analyzes", async () => {
  // The prod scenario behind the merge hold: Delete-all, then the sync pass
  // re-uploads the same content hashes under the next wipe generation.
  let calls = 0;
  const h = makeHarness(async () => {
    calls += 1;
    return result({ title: `analysis ${calls}` });
  });
  await h.append(uploaded("k1"));
  expect(h.events(PROCESSED)).toMatchObject([{ payload: { title: "analysis 1" } }]);

  await h.append({
    type: "events.iterate.com/media/wiped",
    idempotencyKey: "media-wiped-n1",
    payload: { deletedFiles: 1, items: 1 },
  });
  // Same content hash, next wipe generation's idempotency key.
  await h.append({ ...uploaded("k1"), idempotencyKey: "media-captured-k1-g2" });

  expect(calls).toBe(2);
  expect(h.events(PROCESSED)).toMatchObject([
    { payload: { title: "analysis 1" } },
    { payload: { title: "analysis 2", error: null } },
  ]);
  expect(h.state()).toMatchObject({
    items: { k1: { title: "analysis 2", analysisError: null } },
    pendingAnalyses: {},
  });
});

test("an upload ARRIVING after a wipe is analyzed — wipe cancellation is not over-broad", async () => {
  // The plain post-wipe case: a never-analyzed key uploaded after the
  // tombstone. The wipe arm clears obligations that existed BEFORE it; it
  // must not swallow requests that come later.
  let calls = 0;
  const h = makeHarness(async () => {
    calls += 1;
    return result({ title: "fresh analysis" });
  });
  await h.append({
    type: "events.iterate.com/media/wiped",
    idempotencyKey: "media-wiped-n1",
    payload: { deletedFiles: 0, items: 0 },
  });
  await h.append({ ...uploaded("k-new"), idempotencyKey: "media-captured-k-new-g1" });

  expect(calls).toBe(1);
  expect(h.events(PROCESSED)).toMatchObject([
    { payload: { stableKey: "k-new", title: "fresh analysis", error: null } },
  ]);
  expect(h.state()).toMatchObject({ pendingAnalyses: {} });
});

test("a wipe in the same batch cancels the obligation before any attempt starts", async () => {
  let calls = 0;
  const h = makeHarness(async () => {
    calls += 1;
    throw new Error("must never be dialed");
  });
  await h.append(uploaded("k1"), {
    type: "events.iterate.com/media/wiped",
    idempotencyKey: "media-wiped-n1",
    payload: { deletedFiles: 1, items: 1 },
  });

  expect(calls).toBe(0);
  expect(h.events(PROCESSED)).toEqual([]);
  expect(h.state()).toMatchObject({ items: {}, pendingAnalyses: {} });
});

test("full-stream replay re-executes nothing: no vendor calls, no new events, same items", async () => {
  let liveCalls = 0;
  const h = makeHarness(async () => {
    liveCalls += 1;
    return result({ title: `analysis ${liveCalls}` });
  });
  // The history includes a WIPE and a second generation of the same
  // stableKey — a replay must re-dial the vendor for NEITHER generation.
  await h.append(uploaded("k1"));
  await h.append({
    type: "events.iterate.com/media/wiped",
    idempotencyKey: "media-wiped-n1",
    payload: { deletedFiles: 1, items: 1 },
  });
  await h.append({ ...uploaded("k1"), idempotencyKey: "media-captured-k1-g2" });
  expect(liveCalls).toBe(2);
  // Well past every freshness horizon before the replay wakes.
  await h.advanceTime(MEDIA_ANALYSIS_EXPIRY_MS * 2);
  const eventsBefore = h.events().length;

  let replayCalls = 0;
  const replay = makeProcessorHarness<MediaProcessorContract, MediaProcessor>({
    substrate: {
      clock: h.clock,
      stream: h.stream,
      progress: makeMemoryProgressStore(MediaProcessorContract),
    },
    createProcessor: (deps) =>
      makeProcessor(deps, async () => {
        replayCalls += 1;
        throw new Error("replay must never dial the vendor");
      }),
  });
  await replay.settle();

  expect(replayCalls).toBe(0);
  expect(h.events().length).toBe(eventsBefore);
  expect(replay.state().items).toEqual(h.state().items);
  expect(replay.state().pendingAnalyses).toEqual({});
});

// --- helpers ---------------------------------------------------------------

function uploaded(stableKey: string) {
  return {
    type: "events.iterate.com/media/uploaded",
    idempotencyKey: `media-captured-${stableKey}`,
    payload: {
      stableKey,
      path: `/media/${stableKey}-shot.png`,
      filename: "shot.png",
      contentType: "image/png",
      width: 1170,
      height: 2532,
      source: "library-sync",
      capturedAt: "2026-08-10T09:00:00.000Z",
      isScreenshot: true,
    },
  } as const;
}

function result(overrides: Partial<MediaAnalysisResult>): MediaAnalysisResult {
  return {
    title: "",
    markdown: "A train ticket.",
    transcript: "Trenitalia 09:45",
    tags: ["screenshot"],
    processedBy: "test-model",
    ...overrides,
  };
}

function makeProcessor(
  deps: HarnessProcessorDeps<MediaProcessorContract>,
  analyze: (input: {
    path: string;
    filename: string;
    contentType: string;
  }) => Promise<MediaAnalysisResult>,
) {
  return new MediaProcessor({
    stream: deps.stream,
    path: deps.path,
    projectId: deps.projectId,
    now: deps.now,
    sleep: deps.sleep,
    analyze,
  });
}

function makeHarness(
  analyze: (input: {
    path: string;
    filename: string;
    contentType: string;
  }) => Promise<MediaAnalysisResult>,
) {
  return makeProcessorHarness<MediaProcessorContract, MediaProcessor>({
    path: "/media",
    createProcessor: (deps) => makeProcessor(deps, analyze),
  });
}
