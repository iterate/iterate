import { expect, test } from "vitest";
import {
  buildReanalyzeEvent,
  buildUploadedEvent,
  buildWipeScript,
  extendedSinceIso,
  mediaIdempotencyKey,
  readWipeGeneration,
  deriveMediaFeed,
  deriveMediaList,
  filterMedia,
  mapWithConcurrency,
  MEDIA_CAPTURED_EVENT_TYPE,
  MEDIA_PROCESSED_EVENT_TYPE,
  MEDIA_REANALYZE_REQUESTED_EVENT_TYPE,
  MEDIA_UPLOADED_EVENT_TYPE,
  MEDIA_WIPED_EVENT_TYPE,
  mediaFilePath,
  normalizedImageFilename,
  type MediaListItem,
  type MediaPendingCard,
} from "./media.ts";

// Analysis is server-side now (iterate/starter-apps/media — analysis.test.ts
// and media-analysis.test.ts over there own the pipeline and obligation
// behavior); these tests cover the phone's half: the durable event builders,
// the list derivation with its analysis states, and the wipe script.

test("buildUploadedEvent: the whole durable capture is one metadata append", () => {
  expect(
    buildUploadedEvent({
      stableKey: "abc123",
      wipeGeneration: 0,
      filename: "IMG_0001.PNG",
      contentType: "image/png",
      width: 1170,
      height: 2532,
      source: "picker",
      capturedAt: null,
      isScreenshot: null,
    }),
  ).toEqual({
    type: MEDIA_UPLOADED_EVENT_TYPE,
    // Shared spelling with legacy captured events: an item captured before
    // the uploaded-event split can never re-enter as a duplicate.
    idempotencyKey: "media-captured-abc123",
    payload: {
      stableKey: "abc123",
      path: "/media/abc123-IMG_0001.PNG",
      filename: "IMG_0001.PNG",
      contentType: "image/png",
      width: 1170,
      height: 2532,
      source: "picker",
      capturedAt: null,
      isScreenshot: null,
    },
  });
  // Wipe generation flows into the key, so post-wipe re-captures come back.
  expect(
    buildUploadedEvent({
      stableKey: "abc123",
      wipeGeneration: 42,
      filename: "a.png",
      contentType: "image/png",
      width: 1,
      height: 1,
      source: "library-sync",
      capturedAt: "2026-08-10T09:00:00.000Z",
      isScreenshot: true,
    }),
  ).toMatchObject({ idempotencyKey: "media-captured-abc123-g42" });
});

test("buildReanalyzeEvent keys each request separately", () => {
  expect(buildReanalyzeEvent("abc123", "n1")).toEqual({
    type: MEDIA_REANALYZE_REQUESTED_EVENT_TYPE,
    idempotencyKey: "media-reanalyze-abc123-n1",
    payload: { stableKey: "abc123" },
  });
});

test("normalizedImageFilename forces the extension to match the payload type", () => {
  // iOS keeps .HEIC names on recompressed-to-JPEG picks — toMarkdown picks
  // its converter from the extension, so the name must follow the bytes.
  expect(normalizedImageFilename("IMG_1234.HEIC", "image/jpeg", "photo-1")).toBe("IMG_1234.jpeg");
  expect(normalizedImageFilename("shot.png", "image/png", "photo-1")).toBe("shot.png");
  expect(normalizedImageFilename(null, "image/jpeg", "photo-7-0")).toBe("photo-7-0.jpeg");
});

test("mediaFilePath sanitizes and bounds the filename", () => {
  expect(mediaFilePath("abc", "IMG 0001 (edited)?.png")).toBe("/media/abc-IMG_0001_edited_.png");
  expect(mediaFilePath("abc", "x".repeat(200) + ".png")).toMatch(/^.{0,100}\.png$/);
});

test("deriveMediaList: uploaded rows are pending until a processed settlement overlays them", () => {
  const events: any[] = [
    uploadedEvent("a", 1),
    uploadedEvent("b", 2),
    {
      type: MEDIA_PROCESSED_EVENT_TYPE,
      offset: 3,
      createdAt: "t3",
      payload: {
        stableKey: "a",
        title: "Trenitalia ticket",
        markdown: "A train ticket.",
        transcript: "Trenitalia 09:45",
        tags: ["logistics"],
        processedBy: "m",
        error: null,
        requestOffset: 1,
      },
    },
  ];
  expect(deriveMediaList(events)).toMatchObject([
    { offset: 2, analysis: { status: "pending" }, payload: { markdown: "", title: "" } },
    {
      offset: 1,
      analysis: { status: "done" },
      payload: {
        title: "Trenitalia ticket",
        markdown: "A train ticket.",
        tags: ["logistics"],
        // file facts from the uploaded event survive the overlay
        filename: "a.png",
        path: "/media/a-a.png",
      },
    },
  ]);
});

test("deriveMediaList: a failed settlement keeps the row (and its fields) and shows the error", () => {
  const events: any[] = [
    uploadedEvent("a", 1),
    {
      type: MEDIA_PROCESSED_EVENT_TYPE,
      offset: 2,
      createdAt: "t2",
      payload: {
        stableKey: "a",
        title: "",
        markdown: "",
        transcript: "",
        tags: [],
        processedBy: "",
        error: "8005: Internal server error",
        requestOffset: 1,
      },
    },
  ];
  expect(deriveMediaList(events)).toMatchObject([
    {
      offset: 1,
      analysis: { status: "failed", error: "8005: Internal server error" },
      payload: { filename: "a.png" },
    },
  ]);
});

test("deriveMediaList: rows sort by the ORIGINAL image's date, not upload-completion order", () => {
  // Three screenshots synced in parallel: their uploaded events commit in
  // arbitrary order (offset order != date order). The list must not re-sort
  // as uploads land — the asset's own creation time wins.
  const withDate = (stableKey: string, offset: number, capturedAt: string | null) => {
    const event = uploadedEvent(stableKey, offset);
    return { ...event, payload: { ...event.payload, capturedAt } };
  };
  const events: any[] = [
    withDate("middle", 1, "2026-08-10T12:00:00.000Z"),
    withDate("oldest", 2, "2026-08-01T09:00:00.000Z"),
    withDate("newest", 3, "2026-08-11T18:00:00.000Z"),
  ];
  expect(deriveMediaList(events).map((item) => item.payload.stableKey)).toEqual([
    "newest",
    "middle",
    "oldest",
  ]);
});

test("deriveMediaList: a dateless picker item sorts by its event time among dated rows", () => {
  const withDate = (stableKey: string, offset: number, capturedAt: string | null) => {
    const event = uploadedEvent(stableKey, offset);
    return {
      ...event,
      createdAt: "2026-08-11T12:00:00.000Z", // stream time: "just picked"
      payload: { ...event.payload, capturedAt },
    };
  };
  const events: any[] = [
    withDate("old-screenshot", 1, "2026-08-01T09:00:00.000Z"),
    withDate("picked-now", 2, null), // picker strips asset metadata
    withDate("newer-screenshot", 3, "2026-08-12T08:00:00.000Z"),
  ];
  expect(deriveMediaList(events).map((item) => item.payload.stableKey)).toEqual([
    "newer-screenshot",
    "picked-now",
    "old-screenshot",
  ]);
});

test("deriveMediaList: exact date ties break by offset, newest append first", () => {
  const at = "2026-08-10T12:00:00.000Z";
  const withDate = (stableKey: string, offset: number) => {
    const event = uploadedEvent(stableKey, offset);
    return { ...event, payload: { ...event.payload, capturedAt: at } };
  };
  const events: any[] = [withDate("first", 1), withDate("second", 2)];
  expect(deriveMediaList(events).map((item) => item.payload.stableKey)).toEqual([
    "second",
    "first",
  ]);
});

test("deriveMediaList: a failed settlement AFTER a success keeps the successful fields", () => {
  const events: any[] = [
    uploadedEvent("a", 1),
    {
      type: MEDIA_PROCESSED_EVENT_TYPE,
      offset: 2,
      createdAt: "t2",
      payload: {
        stableKey: "a",
        title: "Trenitalia ticket",
        markdown: "A train ticket.",
        transcript: "Trenitalia 09:45",
        tags: ["logistics"],
        processedBy: "m",
        error: null,
        requestOffset: 1,
      },
    },
    {
      type: MEDIA_REANALYZE_REQUESTED_EVENT_TYPE,
      offset: 3,
      createdAt: "t3",
      payload: { stableKey: "a" },
    },
    {
      type: MEDIA_PROCESSED_EVENT_TYPE,
      offset: 4,
      createdAt: "t4",
      // The failed re-analysis carries blank content fields — they must NOT
      // overlay the earlier success (the server fold keeps them the same way).
      payload: {
        stableKey: "a",
        title: "",
        markdown: "",
        transcript: "",
        tags: [],
        processedBy: "",
        error: "8005: Internal server error",
        requestOffset: 3,
      },
    },
  ];
  expect(deriveMediaList(events)).toMatchObject([
    {
      analysis: { status: "failed", error: "8005: Internal server error" },
      payload: {
        title: "Trenitalia ticket",
        markdown: "A train ticket.",
        transcript: "Trenitalia 09:45",
        tags: ["logistics"],
      },
    },
  ]);
});

test("deriveMediaList: a late settlement for a superseded request does not settle the fresh row", () => {
  // Delete-all then re-sync: the pre-wipe attempt settles LATE, after the
  // tombstone, answering the OLD request. The fresh row must stay pending
  // (the server fold keeps its obligation open the same way).
  const events: any[] = [
    uploadedEvent("a", 1),
    { type: MEDIA_WIPED_EVENT_TYPE, offset: 3, createdAt: "t3", payload: {} },
    uploadedEvent("a", 4),
    {
      type: MEDIA_PROCESSED_EVENT_TYPE,
      offset: 5,
      createdAt: "t5",
      payload: {
        stableKey: "a",
        title: "",
        markdown: "",
        transcript: "",
        tags: [],
        processedBy: "",
        error: "pre-wipe attempt died",
        requestOffset: 1, // answers the WIPED generation
      },
    },
  ];
  expect(deriveMediaList(events)).toMatchObject([
    { offset: 4, analysis: { status: "pending", error: null } },
  ]);
});

test("deriveMediaList: reanalyze flips a settled row back to pending until the next settlement", () => {
  const processed = (offset: number, title: string) => ({
    type: MEDIA_PROCESSED_EVENT_TYPE,
    offset,
    createdAt: `t${offset}`,
    payload: {
      stableKey: "a",
      title,
      markdown: "d",
      transcript: "",
      tags: [],
      processedBy: "m",
      error: null,
      requestOffset: null,
    },
  });
  const base: any[] = [
    uploadedEvent("a", 1),
    processed(2, "first"),
    {
      type: MEDIA_REANALYZE_REQUESTED_EVENT_TYPE,
      offset: 3,
      createdAt: "t3",
      payload: { stableKey: "a" },
    },
  ];
  // Request open: pending, but the previous processing stays visible.
  expect(deriveMediaList(base)).toMatchObject([
    { analysis: { status: "pending" }, payload: { title: "first" } },
  ]);
  // Settled again: the newer result overlays.
  expect(deriveMediaList([...base, processed(4, "second")])).toMatchObject([
    { analysis: { status: "done" }, payload: { title: "second" } },
  ]);
});

test("deriveMediaList: legacy captured rows render as before, latest processed overlays", () => {
  const events: any[] = [
    capturedEvent("a", 1, { markdown: "first" }),
    capturedEvent("b", 2, { markdown: "other" }),
    {
      type: MEDIA_PROCESSED_EVENT_TYPE,
      offset: 3,
      createdAt: "t3",
      // Legacy phone-scripted re-analysis payload: no error/requestOffset.
      payload: {
        stableKey: "a",
        title: "",
        markdown: "better",
        transcript: "text!",
        tags: ["receipt"],
        processedBy: "m",
      },
    },
  ];
  expect(deriveMediaList(events)).toMatchObject([
    { offset: 2, analysis: { status: "done" }, payload: { markdown: "other" } },
    {
      offset: 1,
      analysis: { status: "done" },
      payload: { markdown: "better", transcript: "text!", tags: ["receipt"] },
    },
  ]);
});

test("deriveMediaList: one row per stableKey even when captured AND uploaded events exist", () => {
  const events: any[] = [
    capturedEvent("a", 1, { markdown: "inline analysis" }),
    uploadedEvent("a", 2),
  ];
  expect(deriveMediaList(events)).toMatchObject([
    { offset: 1, payload: { markdown: "inline analysis" }, analysis: { status: "done" } },
  ]);
});

test("deriveMediaList resets at the last wiped tombstone", () => {
  const events: any[] = [
    capturedEvent("old", 1, { markdown: "gone" }),
    uploadedEvent("pending-old", 2),
    { type: MEDIA_WIPED_EVENT_TYPE, offset: 3, createdAt: "t3", payload: {} },
    capturedEvent("new", 4, { markdown: "kept" }),
  ];
  expect(deriveMediaList(events)).toMatchObject([{ payload: { stableKey: "new" } }]);
});

test("deriveMediaFeed: cards and rows interleave on the shared original-date key", () => {
  const feed = deriveMediaFeed({
    rows: [
      feedRow("row-old", "2026-08-05T00:00:00.000Z"),
      feedRow("row-new", "2026-08-12T00:00:00.000Z"),
    ],
    allRows: [
      feedRow("row-old", "2026-08-05T00:00:00.000Z"),
      feedRow("row-new", "2026-08-12T00:00:00.000Z"),
    ],
    cards: [
      card({ stableKey: "card-mid", capturedAt: "2026-08-10T00:00:00.000Z" }),
      card({ stableKey: null, capturedAt: null, status: "waiting", previewUri: "p-pick" }),
    ],
    wipedThroughOffset: 0,
  });
  expect(feed.map((entry) => entry.key)).toEqual([
    "pending:p-pick", // dateless picker card counts as newest (and keys on its preview pre-hash)
    "row-new",
    "card-mid",
    "row-old",
  ]);
  expect(feed.map((entry) => entry.kind)).toEqual(["pending", "row", "pending", "row"]);
});

test("deriveMediaFeed: a card morphs into its row — exactly one entry, same key, same position", () => {
  const cards = [
    card({ stableKey: "a", capturedAt: "2026-08-10T00:00:00.000Z" }),
    card({ stableKey: "b", capturedAt: "2026-08-08T00:00:00.000Z" }),
  ];
  const existing = feedRow("older", "2026-08-09T00:00:00.000Z");
  const before = deriveMediaFeed({
    rows: [existing],
    allRows: [existing],
    cards,
    wipedThroughOffset: 0,
  });
  expect(before.map((entry) => entry.key)).toEqual(["a", "older", "b"]);

  // a's uploaded event lands: the derived row replaces the card in place —
  // never two entries (no duplicate render) and never zero (no gap), even
  // though the card is still sitting in component state.
  const resolved = feedRow("a", "2026-08-10T00:00:00.000Z");
  const after = deriveMediaFeed({
    rows: [resolved, existing],
    allRows: [resolved, existing],
    cards,
    wipedThroughOffset: 0,
  });
  expect(after.map((entry) => entry.key)).toEqual(["a", "older", "b"]);
  expect(after.map((entry) => entry.kind)).toEqual(["row", "row", "pending"]);
});

test("deriveMediaFeed: suppression checks ALL rows, so a search filter cannot resurrect a resolved card", () => {
  const resolved = feedRow("a", "2026-08-10T00:00:00.000Z");
  const feed = deriveMediaFeed({
    rows: [], // search filtered the row out
    allRows: [resolved],
    cards: [card({ stableKey: "a", capturedAt: "2026-08-10T00:00:00.000Z" })],
    wipedThroughOffset: 0,
  });
  expect(feed).toEqual([]);
});

test("deriveMediaFeed: terminal skipped/error cards coexist with rows under their own keys", () => {
  const row = feedRow("a", "2026-08-10T00:00:00.000Z");
  const feed = deriveMediaFeed({
    rows: [row],
    allRows: [row],
    cards: [
      // "skipped" MEANS a row already exists — both must render, without a
      // React key collision.
      card({ stableKey: "a", capturedAt: null, status: "skipped", previewUri: "p-skip" }),
      card({ stableKey: "b", capturedAt: null, status: "error", previewUri: "p-err" }),
    ],
    wipedThroughOffset: 0,
  });
  expect(feed.map((entry) => entry.key)).toEqual(["pending:p-skip", "pending:p-err", "a"]);
});

test("deriveMediaFeed: a wipe supersedes done cards — no ghost spinners after Delete-all", () => {
  const doneCard = card({
    stableKey: "a",
    status: "done",
    uploadedOffset: 5,
    capturedAt: "2026-08-10T00:00:00.000Z",
  });
  // Before its row arrives, the done card bridges the gap…
  expect(
    deriveMediaFeed({ rows: [], allRows: [], cards: [doneCard], wipedThroughOffset: 0 }),
  ).toMatchObject([{ kind: "pending", key: "a" }]);
  // …but once a wipe tombstone lands at/past its append, the rows are gone
  // FOR GOOD and the card must not resurface as an eternal spinner.
  expect(
    deriveMediaFeed({ rows: [], allRows: [], cards: [doneCard], wipedThroughOffset: 7 }),
  ).toEqual([]);
});

test("deriveMediaFeed: two concurrent cards with identical content hash keep unique keys", () => {
  const feed = deriveMediaFeed({
    rows: [],
    allRows: [],
    cards: [
      card({ stableKey: "same", capturedAt: null, previewUri: "p-one" }),
      card({ stableKey: "same", capturedAt: null, previewUri: "p-two" }),
    ],
    wipedThroughOffset: 0,
  });
  expect(feed.map((entry) => entry.key)).toEqual(["same", "pending:p-two"]);
});

test("filterMedia: terms AND together over markdown+transcript+filename+tags, chips must all match", () => {
  const items: MediaListItem[] = [
    item(1, "A train ticket from Rome to Florence", "TRENITALIA 09:45", ["logistics"]),
    item(2, "Stack trace from the mobile app", "TypeError: undefined", ["screenshot", "code"]),
    item(3, "Meme about trains", "", ["clipping"]),
  ];
  expect(filterMedia(items, "train ticket", [])).toMatchObject([{ offset: 1 }]);
  // Deep links search by the SANITIZED name carried in the stored path
  // (spaces become underscores) — that segment is part of the haystack, but
  // the /media/ prefix and hash are NOT: "media" must not match everything.
  expect(filterMedia(items, "f.png", [])).toMatchObject([
    { offset: 1 },
    { offset: 2 },
    { offset: 3 },
  ]);
  expect(filterMedia(items, "/media", [])).toEqual([]);
  expect(filterMedia(items, "trenitalia", [])).toMatchObject([{ offset: 1 }]); // transcript hit
  expect(filterMedia(items, "typeerror", [])).toMatchObject([{ offset: 2 }]);
  expect(filterMedia(items, "", ["screenshot", "code"])).toMatchObject([{ offset: 2 }]);
  expect(filterMedia(items, "trace", ["clipping"])).toEqual([]);
});

test("mapWithConcurrency bounds in-flight work and preserves order", async () => {
  let inFlight = 0;
  let peak = 0;
  const results = await mapWithConcurrency([10, 20, 30, 40, 50], 2, async (n) => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 5));
    inFlight -= 1;
    return n * 2;
  });
  expect(results).toEqual([20, 40, 60, 80, 100]);
  expect(peak).toBe(2);
});

test("wipe script deletes files from BOTH birth event types then appends the tombstone", async () => {
  const itx = fakeItx({
    streamEvents: [
      { type: MEDIA_CAPTURED_EVENT_TYPE, offset: 1, payload: { path: "/media/a-x.png" } },
      { type: MEDIA_UPLOADED_EVENT_TYPE, offset: 2, payload: { path: "/media/b-y.png" } },
      { type: MEDIA_CAPTURED_EVENT_TYPE, offset: 3, payload: { path: "/media/a-x.png" } },
    ],
  });
  await runScript(buildWipeScript("n1"), itx);
  expect(itx.calls.eventTypesRead).toEqual([MEDIA_CAPTURED_EVENT_TYPE, MEDIA_UPLOADED_EVENT_TYPE]);
  expect(itx.calls.deletedPaths).toEqual(["/media/a-x.png", "/media/b-y.png"]); // deduped
  expect(itx.calls.appended).toMatchObject({
    type: MEDIA_WIPED_EVENT_TYPE,
    idempotencyKey: "media-wiped-n1",
    payload: { deletedFiles: 2, items: 2 },
  });
});

test("wipe generation changes the capture identity so re-captures work after Delete-all", async () => {
  expect(mediaIdempotencyKey("abc", 0)).toBe("media-captured-abc");
  expect(mediaIdempotencyKey("abc", 42)).toBe("media-captured-abc-g42");
  const stream: any = {
    getEvents: async (args: any) =>
      args.eventTypes[0] === MEDIA_WIPED_EVENT_TYPE && args.afterOffset === 0
        ? [{ offset: 7 }, { offset: 42 }]
        : [],
  };
  expect(await readWipeGeneration(stream)).toBe(42);
  expect(await readWipeGeneration({ getEvents: async () => [] })).toBe(0);
});

test("extendedSinceIso only ever extends an enabled window backwards", () => {
  const now = Date.parse("2026-08-11T12:00:00.000Z");
  const week = extendedSinceIso(null, 7, now);
  expect(week).toBe("2026-08-04T12:00:00.000Z");
  // Re-confirming with a SHORTER chip keeps the older boundary…
  expect(extendedSinceIso("2026-07-01T00:00:00.000Z", 7, now)).toBe("2026-07-01T00:00:00.000Z");
  // …and a longer chip extends it.
  expect(extendedSinceIso("2026-08-10T00:00:00.000Z", 30, now)).toBe("2026-07-12T12:00:00.000Z");
});

// --- helpers ---------------------------------------------------------------

function uploadedEvent(stableKey: string, offset: number) {
  return {
    type: MEDIA_UPLOADED_EVENT_TYPE,
    offset,
    createdAt: `t${offset}`,
    payload: {
      stableKey,
      path: `/media/${stableKey}-${stableKey}.png`,
      filename: `${stableKey}.png`,
      contentType: "image/png",
      width: 100,
      height: 200,
      source: "picker",
      capturedAt: null,
      isScreenshot: null,
    },
  };
}

function capturedEvent(stableKey: string, offset: number, processing: { markdown: string }) {
  return {
    type: MEDIA_CAPTURED_EVENT_TYPE,
    offset,
    createdAt: `t${offset}`,
    payload: {
      stableKey,
      path: `/media/${stableKey}-${stableKey}.png`,
      filename: `${stableKey}.png`,
      contentType: "image/png",
      width: 100,
      height: 200,
      source: "picker",
      capturedAt: null,
      isScreenshot: null,
      title: "",
      markdown: processing.markdown,
      transcript: "",
      tags: [],
      processedBy: "m",
    },
  };
}

function feedRow(stableKey: string, capturedAt: string | null): MediaListItem {
  return {
    offset: 1,
    capturedAt: "2026-08-12T12:00:00.000Z", // event stream time — the fallback instant
    analysis: { status: "done", error: null },
    payload: {
      stableKey,
      path: `/media/${stableKey}-f.png`,
      filename: "f.png",
      contentType: "image/png",
      width: 1,
      height: 1,
      title: "",
      markdown: "",
      transcript: "",
      tags: [],
      processedBy: "test",
      source: "library-sync" as const,
      capturedAt,
      isScreenshot: true,
    },
  };
}

function card(overrides: Partial<MediaPendingCard>): MediaPendingCard {
  return {
    previewUri: `p-${overrides.stableKey || "x"}`,
    filename: "f.png",
    stableKey: null,
    uploadedOffset: null,
    capturedAt: null,
    status: "uploading",
    ...overrides,
  };
}

function item(offset: number, markdown: string, transcript: string, tags: string[]): MediaListItem {
  return {
    offset,
    capturedAt: `2026-08-10T00:00:0${offset}Z`,
    analysis: { status: "done", error: null },
    payload: {
      stableKey: `k${offset}`,
      path: `/media/k${offset}-f.png`,
      filename: "f.png",
      contentType: "image/png",
      width: 1,
      height: 1,
      title: "",
      markdown,
      transcript,
      tags,
      processedBy: "test",
      source: "picker" as const,
      capturedAt: null,
      isScreenshot: null,
    },
  };
}

function fakeItx(behavior: { streamEvents: any[] }): any {
  const calls: any = {};
  return {
    calls,
    streams: {
      get: () => ({
        getEvents: async (args: any) => {
          calls.eventTypesRead = args.eventTypes;
          return args.afterOffset === 0 ? behavior.streamEvents : [];
        },
        append: async (event: any) => {
          calls.appended = event;
          return [{ ...event, offset: 1 }];
        },
      }),
    },
    files: {
      get: (path: string) => ({
        delete: async () => {
          (calls.deletedPaths ||= []).push(path);
        },
      }),
    },
  };
}

async function runScript(code: string, itx: any): Promise<any> {
  // eslint-disable-next-line no-new-func -- evaluating the generated script IS the test
  const fn = new Function(`return (${code})`)();
  return await fn(itx);
}
