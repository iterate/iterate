import { expect, test } from "vitest";
import {
  buildProcessScript,
  buildWipeScript,
  extendedSinceIso,
  mediaIdempotencyKey,
  readWipeGeneration,
  deriveMediaList,
  filterMedia,
  mapWithConcurrency,
  MEDIA_CAPTURED_EVENT_TYPE,
  MEDIA_PROCESSED_EVENT_TYPE,
  MEDIA_WIPED_EVENT_TYPE,
  mediaFilePath,
  normalizedImageFilename,
  type MediaListItem,
} from "./media.ts";

// The script builder's output is what actually runs server-side, so the
// tests EVALUATE it against a fake itx rather than asserting on the string.

test("capture script describes, transcribes, tags, and appends one idempotent event", async () => {
  const itx = fakeItx({
    toMarkdown: { format: "markdown", data: "A train ticket from Rome to Florence.\n" },
    // OpenAI-style answer shape (what llama on Workers AI actually returns),
    // wrapped in chatter the JSON extractor must see through.
    visionAnswer: {
      choices: [
        {
          message: {
            content:
              'Here is the JSON: {"title": "Trenitalia ticket to Florence", "transcript": "Train to Florence\\nSeat 21A", "tags": ["logistics", "Screenshot!", "screenshot"]}',
          },
        },
      ],
    },
  });
  const result = await runScript(
    buildProcessScript({
      wipeGeneration: 0,
      stableKey: "abc123",
      filename: "IMG_0001.PNG",
      contentType: "image/png",
      width: 1170,
      height: 2532,
      source: "picker",
      capturedAt: null,
      isScreenshot: null,
      mode: "capture",
    }),
    itx,
  );

  expect(itx.calls.bytesPath).toBe("/media/abc123-IMG_0001.PNG");
  expect(itx.calls.visionBody.messages[0].content[1].image_url.url).toMatch(
    /^data:image\/png;base64,/,
  );
  expect(itx.calls.appended).toMatchObject({
    type: MEDIA_CAPTURED_EVENT_TYPE,
    idempotencyKey: "media-captured-abc123",
    payload: {
      stableKey: "abc123",
      title: "Trenitalia ticket to Florence",
      markdown: "A train ticket from Rome to Florence.",
      transcript: "Train to Florence\nSeat 21A",
      // lowercased, punctuation folded, deduped
      tags: ["logistics", "screenshot"],
      width: 1170,
      height: 2532,
      source: "picker",
      capturedAt: null,
      isScreenshot: null,
    },
  });
  expect(result).toMatchObject({ offset: 1 });
});

test("reprocess mode appends a processed event and skips the dedup check", async () => {
  const existing = { offset: 7, type: MEDIA_CAPTURED_EVENT_TYPE };
  const itx = fakeItx({
    existingEvent: existing, // would short-circuit a capture — must be ignored
    toMarkdown: { format: "markdown", data: "Better description." },
    visionAnswer: {
      choices: [{ message: { content: '{"transcript": "", "tags": ["receipt"]}' } }],
    },
  });
  await runScript(
    buildProcessScript({
      wipeGeneration: 0,
      stableKey: "abc123",
      filename: "IMG_0001.PNG",
      contentType: "image/png",
      width: 10,
      height: 10,
      source: "picker",
      capturedAt: null,
      isScreenshot: null,
      mode: { reprocessNonce: "n1" },
    }),
    itx,
  );
  expect(itx.calls.appended).toMatchObject({
    type: MEDIA_PROCESSED_EVENT_TYPE,
    idempotencyKey: "media-processed-abc123-n1",
    payload: { stableKey: "abc123", markdown: "Better description.", tags: ["receipt"] },
  });
  // Reprocess payloads carry no file facts — the captured event owns those.
  expect(itx.calls.appended.payload.path).toBeUndefined();
});

test("oversized images are downscaled for the vision call only", async () => {
  const itx = fakeItx({
    toMarkdown: { format: "markdown", data: "desc" },
    visionAnswer: {
      choices: [{ message: { content: '{"title": "t", "transcript": "", "tags": []}' } }],
    },
    fileBytes: new Uint8Array(1_500_000),
  });
  await runScript(
    buildProcessScript({
      wipeGeneration: 0,
      stableKey: "big",
      filename: "tall.png",
      contentType: "image/png",
      width: 1170,
      height: 20_000,
      source: "picker",
      capturedAt: null,
      isScreenshot: null,
      mode: "capture",
    }),
    itx,
  );
  expect(itx.calls.transformInput).toMatchObject({
    transforms: [{ width: 1280 }],
    output: { format: "image/jpeg" },
  });
  // The AI call got the small jpeg; the stored original was untouched.
  expect(itx.calls.visionBody.messages[0].content[1].image_url.url).toMatch(
    /^data:image\/jpeg;base64,/,
  );
});

test("hostile filenames cannot break out of the script", async () => {
  const filename = 'x"; process.exit(1);   //`${boom}`.png';
  const itx = fakeItx({
    toMarkdown: { format: "markdown", data: "desc" },
    visionAnswer: {
      choices: [{ message: { content: '{"transcript": "", "tags": ["clipping"]}' } }],
    },
  });
  await runScript(
    buildProcessScript({
      wipeGeneration: 0,
      stableKey: "k1",
      filename,
      contentType: "image/png",
      width: 10,
      height: 10,
      source: "picker",
      capturedAt: null,
      isScreenshot: null,
      mode: "capture",
    }),
    itx,
  );
  expect(itx.calls.appended).toMatchObject({ payload: { filename, tags: ["clipping"] } });
});

test("already-captured stableKey short-circuits before any AI call", async () => {
  const existing = { offset: 7, type: MEDIA_CAPTURED_EVENT_TYPE };
  const itx = fakeItx({
    existingEvent: existing,
    toMarkdown: { format: "markdown", data: "unused" },
    visionAnswer: { choices: [{ message: { content: "{}" } }] },
  });
  const result = await runScript(
    buildProcessScript({
      wipeGeneration: 0,
      stableKey: "dup",
      filename: "a.png",
      contentType: "image/png",
      width: 1,
      height: 1,
      source: "picker",
      capturedAt: null,
      isScreenshot: null,
      mode: "capture",
    }),
    itx,
  );
  expect(result).toBe(existing);
  expect(itx.calls.bytesPath).toBeUndefined();
  expect(itx.calls.appended).toBeUndefined();
});

test("unparseable vision output degrades to untagged + empty transcript; conversion error throws", async () => {
  const itx = fakeItx({
    toMarkdown: { format: "markdown", data: "desc" },
    visionAnswer: { choices: [{ message: { content: "I could not decide, sorry!" } }] },
  });
  await runScript(
    buildProcessScript({
      wipeGeneration: 0,
      stableKey: "k2",
      filename: "a.png",
      contentType: "image/png",
      width: 1,
      height: 1,
      source: "picker",
      capturedAt: null,
      isScreenshot: null,
      mode: "capture",
    }),
    itx,
  );
  expect(itx.calls.appended).toMatchObject({ payload: { tags: ["untagged"], transcript: "" } });

  const failing = fakeItx({
    toMarkdown: { format: "error", error: "unsupported" },
    visionAnswer: { choices: [{ message: { content: "{}" } }] },
  });
  await expect(
    runScript(
      buildProcessScript({
        wipeGeneration: 0,
        stableKey: "k3",
        filename: "b.png",
        contentType: "image/png",
        width: 1,
        height: 1,
        source: "picker",
        capturedAt: null,
        isScreenshot: null,
        mode: "capture",
      }),
      failing,
    ),
  ).rejects.toThrow(/toMarkdown failed for b.png: unsupported/);
});

test("empty tags array is preserved — conservative no-tags is a valid answer", async () => {
  const itx = fakeItx({
    toMarkdown: { format: "markdown", data: "desc" },
    visionAnswer: { choices: [{ message: { content: '{"transcript": "hi", "tags": []}' } }] },
  });
  await runScript(
    buildProcessScript({
      wipeGeneration: 0,
      stableKey: "k4",
      filename: "a.png",
      contentType: "image/png",
      width: 1,
      height: 1,
      source: "picker",
      capturedAt: null,
      isScreenshot: null,
      mode: "capture",
    }),
    itx,
  );
  expect(itx.calls.appended).toMatchObject({ payload: { tags: [], transcript: "hi" } });
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

test("deriveMediaList overlays the latest processed result per item, newest first", () => {
  const events: any[] = [
    {
      type: MEDIA_CAPTURED_EVENT_TYPE,
      offset: 1,
      createdAt: "t1",
      payload: { stableKey: "a", markdown: "first", transcript: "", tags: ["untagged"] },
    },
    {
      type: MEDIA_CAPTURED_EVENT_TYPE,
      offset: 2,
      createdAt: "t2",
      payload: { stableKey: "b", markdown: "other", transcript: "", tags: [] },
    },
    {
      type: MEDIA_PROCESSED_EVENT_TYPE,
      offset: 3,
      createdAt: "t3",
      payload: { stableKey: "a", markdown: "better", transcript: "text!", tags: ["receipt"] },
    },
  ];
  expect(deriveMediaList(events)).toMatchObject([
    { offset: 2, payload: { markdown: "other" } },
    { offset: 1, payload: { markdown: "better", transcript: "text!", tags: ["receipt"] } },
  ]);
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

test("wipe script deletes every stored file then appends the tombstone", async () => {
  const itx = fakeItx({
    toMarkdown: { format: "markdown", data: "unused" },
    visionAnswer: { choices: [{ message: { content: "{}" } }] },
    streamEvents: [
      { type: MEDIA_CAPTURED_EVENT_TYPE, offset: 1, payload: { path: "/media/a-x.png" } },
      { type: MEDIA_CAPTURED_EVENT_TYPE, offset: 2, payload: { path: "/media/b-y.png" } },
      { type: MEDIA_CAPTURED_EVENT_TYPE, offset: 3, payload: { path: "/media/a-x.png" } },
    ],
  });
  await runScript(buildWipeScript("n1"), itx);
  expect(itx.calls.deletedPaths).toEqual(["/media/a-x.png", "/media/b-y.png"]); // deduped
  expect(itx.calls.appended).toMatchObject({
    type: MEDIA_WIPED_EVENT_TYPE,
    idempotencyKey: "media-wiped-n1",
    payload: { deletedFiles: 2, items: 2 },
  });
});

test("deriveMediaList resets at the last wiped tombstone", () => {
  const events: any[] = [
    {
      type: MEDIA_CAPTURED_EVENT_TYPE,
      offset: 1,
      createdAt: "t1",
      payload: { stableKey: "old", markdown: "gone", transcript: "", tags: [] },
    },
    { type: MEDIA_WIPED_EVENT_TYPE, offset: 2, createdAt: "t2", payload: {} },
    {
      type: MEDIA_CAPTURED_EVENT_TYPE,
      offset: 3,
      createdAt: "t3",
      payload: { stableKey: "new", markdown: "kept", transcript: "", tags: [] },
    },
  ];
  expect(deriveMediaList(events)).toMatchObject([{ payload: { stableKey: "new" } }]);
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

function item(offset: number, markdown: string, transcript: string, tags: string[]): MediaListItem {
  return {
    offset,
    capturedAt: `2026-08-10T00:00:0${offset}Z`,
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

function fakeItx(behavior: {
  toMarkdown: any;
  visionAnswer: any;
  existingEvent?: any;
  fileBytes?: Uint8Array;
  streamEvents?: any[];
}): any {
  const calls: any = {};
  return {
    calls,
    streams: {
      get: () => ({
        getEvent: async () => behavior.existingEvent,
        getEvents: async (args: any) => (args.afterOffset === 0 ? behavior.streamEvents || [] : []),
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
        bytes: async () => {
          calls.bytesPath = path;
          return behavior.fileBytes || new Uint8Array([1, 2, 3]);
        },
      }),
    },
    integrations: {
      cf: {
        images: {
          transformBytes: async (input: any) => {
            calls.transformInput = input;
            return { bytes: new Uint8Array([9, 9]), contentType: "image/jpeg" };
          },
        },
      },
    },
    ai: {
      toMarkdown: async (doc: any) => {
        calls.toMarkdownDoc = doc;
        return behavior.toMarkdown;
      },
      run: async (model: string, body: any) => {
        calls.visionModel = model;
        calls.visionBody = body;
        return behavior.visionAnswer;
      },
    },
  };
}

async function runScript(code: string, itx: any): Promise<any> {
  // eslint-disable-next-line no-new-func -- evaluating the generated script IS the test
  const fn = new Function(`return (${code})`)();
  return await fn(itx);
}
