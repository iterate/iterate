// The vision pipeline against a fake itx session (ported from the mobile
// capture-script tests when analysis moved server-side — the script builder
// and its injection-safety concerns died with the script).
import { expect, test } from "vitest";
import { analyzeMediaImage } from "./analysis.ts";

test("describes, transcribes, and tags: normalized, deduped, chatter-tolerant", async () => {
  const session = fakeSession({
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
  const result = await analyzeMediaImage(session, {
    path: "/media/abc123-IMG_0001.PNG",
    filename: "IMG_0001.PNG",
    contentType: "image/png",
  });

  expect(session.calls.bytesPath).toBe("/media/abc123-IMG_0001.PNG");
  expect(session.calls.visionBody.messages[0].content[1].image_url.url).toMatch(
    /^data:image\/png;base64,/,
  );
  expect(result).toMatchObject({
    title: "Trenitalia ticket to Florence",
    markdown: "A train ticket from Rome to Florence.",
    transcript: "Train to Florence\nSeat 21A",
    // lowercased, punctuation folded, deduped
    tags: ["logistics", "screenshot"],
    processedBy: expect.stringContaining("@cf/"),
  });
});

test("oversized images are downscaled for the vision call only", async () => {
  const session = fakeSession({
    toMarkdown: { format: "markdown", data: "desc" },
    visionAnswer: {
      choices: [{ message: { content: '{"title": "t", "transcript": "", "tags": []}' } }],
    },
    fileBytes: new Uint8Array(1_500_000),
  });
  await analyzeMediaImage(session, {
    path: "/media/big-tall.png",
    filename: "tall.png",
    contentType: "image/png",
  });

  expect(session.calls.transformInput).toMatchObject({
    transforms: [{ width: 1280 }],
    output: { format: "image/jpeg" },
  });
  // The AI call got the small jpeg; the stored original was untouched.
  expect(session.calls.visionBody.messages[0].content[1].image_url.url).toMatch(
    /^data:image\/jpeg;base64,/,
  );
});

test("unparseable vision output degrades to untagged + empty transcript", async () => {
  const session = fakeSession({
    toMarkdown: { format: "markdown", data: "desc" },
    visionAnswer: { choices: [{ message: { content: "I could not decide, sorry!" } }] },
  });
  const result = await analyzeMediaImage(session, {
    path: "/media/k2-a.png",
    filename: "a.png",
    contentType: "image/png",
  });
  expect(result).toMatchObject({ tags: ["untagged"], transcript: "", markdown: "desc" });
});

test("a conversion error throws — the obligation attempt owns retry/settlement", async () => {
  const session = fakeSession({
    toMarkdown: { format: "error", error: "unsupported" },
    visionAnswer: { choices: [{ message: { content: "{}" } }] },
  });
  await expect(
    analyzeMediaImage(session, {
      path: "/media/k3-b.png",
      filename: "b.png",
      contentType: "image/png",
    }),
  ).rejects.toThrow(/toMarkdown failed for b.png: unsupported/);
});

test("empty tags array is preserved — conservative no-tags is a valid answer", async () => {
  const session = fakeSession({
    toMarkdown: { format: "markdown", data: "desc" },
    visionAnswer: { choices: [{ message: { content: '{"transcript": "hi", "tags": []}' } }] },
  });
  const result = await analyzeMediaImage(session, {
    path: "/media/k4-a.png",
    filename: "a.png",
    contentType: "image/png",
  });
  expect(result).toMatchObject({ tags: [], transcript: "hi" });
});

test("the bare { response } Workers AI answer shape parses too", async () => {
  const session = fakeSession({
    toMarkdown: { format: "markdown", data: "desc" },
    visionAnswer: { response: '{"title": "plain response", "transcript": "", "tags": []}' },
  });
  const result = await analyzeMediaImage(session, {
    path: "/media/k5-a.png",
    filename: "a.png",
    contentType: "image/png",
  });
  expect(result).toMatchObject({ title: "plain response" });
});

// --- helpers ---------------------------------------------------------------

function fakeSession(behavior: {
  toMarkdown: any;
  visionAnswer: any;
  fileBytes?: Uint8Array;
}): any {
  const calls: any = {};
  return {
    calls,
    files: {
      get: (path: string) => ({
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
