import { expect, test } from "vitest";
import {
  buildCaptureScript,
  deriveScreenshotList,
  filterScreenshots,
  SCREENSHOT_CAPTURED_EVENT_TYPE,
  screenshotFilePath,
  type ScreenshotListItem,
} from "./screenshots.ts";

// The script builder's output is what actually runs server-side, so the
// tests EVALUATE it against a fake itx rather than asserting on the string.

test("capture script converts, tags, and appends one idempotent event", async () => {
  const itx = fakeItx({
    toMarkdown: { format: "markdown", data: "A train ticket from Rome to Florence.\n" },
    // OpenAI-style answer shape (what llama on Workers AI actually returns).
    aiAnswer: {
      choices: [
        {
          message: {
            content: 'Sure! Here you go: ["logistics", "Receipt!", "receipt", "logistics"]',
          },
        },
      ],
    },
  });
  const result = await runCaptureScript(
    buildCaptureScript({
      stableKey: "abc123",
      filename: "IMG_0001.PNG",
      contentType: "image/png",
      width: 1170,
      height: 2532,
    }),
    itx,
  );

  expect(itx.calls.bytesPath).toBe("/screenshots/inbound/abc123-IMG_0001.PNG");
  expect(itx.calls.appended).toMatchObject({
    type: SCREENSHOT_CAPTURED_EVENT_TYPE,
    idempotencyKey: "screenshot-captured-abc123",
    payload: {
      stableKey: "abc123",
      markdown: "A train ticket from Rome to Florence.",
      // parsed from the chatty answer: lowercased, punctuation folded, deduped
      tags: ["logistics", "receipt"],
      width: 1170,
      height: 2532,
    },
  });
  expect(result).toMatchObject({ offset: 1 });
});

test("hostile filenames cannot break out of the script", async () => {
  const filename = 'x"; process.exit(1);   //`${boom}`.png';
  const itx = fakeItx({
    toMarkdown: { format: "markdown", data: "desc" },
    aiResponse: '["media"]',
  });
  await runCaptureScript(
    buildCaptureScript({
      stableKey: "k1",
      filename,
      contentType: "image/png",
      width: 10,
      height: 10,
    }),
    itx,
  );
  expect(itx.calls.appended).toMatchObject({ payload: { filename, tags: ["media"] } });
});

test("already-captured stableKey short-circuits before any AI call", async () => {
  const existing = { offset: 7, type: SCREENSHOT_CAPTURED_EVENT_TYPE };
  const itx = fakeItx({
    existingEvent: existing,
    toMarkdown: { format: "markdown", data: "unused" },
    aiResponse: "[]",
  });
  const result = await runCaptureScript(
    buildCaptureScript({
      stableKey: "dup",
      filename: "a.png",
      contentType: "image/png",
      width: 1,
      height: 1,
    }),
    itx,
  );
  expect(result).toBe(existing);
  expect(itx.calls.bytesPath).toBeUndefined();
  expect(itx.calls.appended).toBeUndefined();
});

test("unparseable tagger output degrades to untagged, conversion error throws", async () => {
  const itx = fakeItx({
    toMarkdown: { format: "markdown", data: "desc" },
    aiResponse: "I could not decide on tags, sorry!",
  });
  await runCaptureScript(
    buildCaptureScript({
      stableKey: "k2",
      filename: "a.png",
      contentType: "image/png",
      width: 1,
      height: 1,
    }),
    itx,
  );
  expect(itx.calls.appended).toMatchObject({ payload: { tags: ["untagged"] } });

  const failing = fakeItx({
    toMarkdown: { format: "error", error: "unsupported" },
    aiResponse: "[]",
  });
  await expect(
    runCaptureScript(
      buildCaptureScript({
        stableKey: "k3",
        filename: "b.png",
        contentType: "image/png",
        width: 1,
        height: 1,
      }),
      failing,
    ),
  ).rejects.toThrow(/toMarkdown failed for b.png: unsupported/);
});

test("screenshotFilePath sanitizes and bounds the filename", () => {
  expect(screenshotFilePath("abc", "IMG 0001 (edited)?.png")).toBe(
    "/screenshots/inbound/abc-IMG_0001_edited_.png",
  );
  expect(screenshotFilePath("abc", "x".repeat(200) + ".png")).toMatch(/^.{0,100}\.png$/);
});

test("filterScreenshots: terms AND together over markdown+filename+tags, chips must all match", () => {
  const items: ScreenshotListItem[] = [
    item(1, "A train ticket from Rome to Florence", ["logistics"]),
    item(2, "Stack trace from the iterate mobile app", ["bug-report", "iterate"]),
    item(3, "Meme about trains", ["media"]),
  ];
  expect(filterScreenshots(items, "train ticket", [])).toMatchObject([{ offset: 1 }]);
  expect(filterScreenshots(items, "train", [])).toMatchObject([{ offset: 1 }, { offset: 3 }]);
  expect(filterScreenshots(items, "", ["iterate", "bug-report"])).toMatchObject([{ offset: 2 }]);
  expect(filterScreenshots(items, "trace", ["media"])).toEqual([]);
});

test("deriveScreenshotList keeps only captured events, newest first", () => {
  const events: any[] = [
    { type: SCREENSHOT_CAPTURED_EVENT_TYPE, offset: 1, createdAt: "t1", payload: { tags: [] } },
    { type: "events.iterate.com/other", offset: 2, createdAt: "t2", payload: {} },
    { type: SCREENSHOT_CAPTURED_EVENT_TYPE, offset: 3, createdAt: "t3", payload: { tags: [] } },
  ];
  expect(deriveScreenshotList(events)).toMatchObject([{ offset: 3 }, { offset: 1 }]);
});

// --- helpers ---------------------------------------------------------------

function item(offset: number, markdown: string, tags: string[]): ScreenshotListItem {
  return {
    offset,
    capturedAt: `2026-08-10T00:00:0${offset}Z`,
    payload: {
      stableKey: `k${offset}`,
      path: `/screenshots/inbound/k${offset}-f.png`,
      filename: "f.png",
      contentType: "image/png",
      width: 1,
      height: 1,
      markdown,
      tags,
      taggedBy: "test",
    },
  };
}

function fakeItx(behavior: {
  toMarkdown: any;
  aiResponse?: string;
  aiAnswer?: any;
  existingEvent?: any;
}): any {
  const calls: any = {};
  return {
    calls,
    streams: {
      get: () => ({
        getEvent: async () => behavior.existingEvent,
        append: async (event: any) => {
          calls.appended = event;
          return [{ ...event, offset: 1 }];
        },
      }),
    },
    files: {
      get: (path: string) => ({
        bytes: async () => {
          calls.bytesPath = path;
          return new Uint8Array([1, 2, 3]);
        },
      }),
    },
    ai: {
      toMarkdown: async (doc: any) => {
        calls.toMarkdownDoc = doc;
        return behavior.toMarkdown;
      },
      run: async (model: string, body: any) => {
        calls.taggerModel = model;
        calls.taggerBody = body;
        return behavior.aiAnswer || { response: behavior.aiResponse };
      },
    },
  };
}

async function runCaptureScript(code: string, itx: any): Promise<any> {
  // eslint-disable-next-line no-new-func -- evaluating the generated script IS the test
  const fn = new Function(`return (${code})`)();
  return await fn(itx);
}
