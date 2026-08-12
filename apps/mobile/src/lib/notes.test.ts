import { expect, test } from "vitest";
import {
  buildCapturedEvent,
  buildDeletedEvent,
  deriveNotesList,
  filterNotes,
  newNoteKey,
  noteFirstLine,
} from "./notes.ts";

const capturedEvent = (offset: number, noteKey: string, text: string, attachments: any[] = []) => ({
  type: "events.iterate.com/notes/captured",
  offset,
  createdAt: `2026-08-12T10:0${offset}:00.000Z`,
  payload: { noteKey, text, attachments, capturedOnDeviceAt: null },
});

const settledEvent = (offset: number, noteKey: string, result: any, requestOffset = 1) => ({
  type: "events.iterate.com/notes/analysis-settled",
  offset,
  createdAt: `2026-08-12T10:0${offset}:00.000Z`,
  payload: { noteKey, requestOffset, result },
});

test("deriveNotesList: first-line title until analysis lands, newest first, tombstones remove", () => {
  const items = deriveNotesList([
    capturedEvent(1, "n1", "  \nbuy milk\nand eggs"),
    capturedEvent(2, "n2", "standing desk at 76cm"),
    settledEvent(
      3,
      "n2",
      { status: "succeeded", title: "Standing desk height", tags: ["reference"], processedBy: "m" },
      2, // the obligation the n2 capture (offset 2) opened
    ),
    {
      type: "events.iterate.com/notes/deleted",
      offset: 4,
      createdAt: "t4",
      payload: { noteKey: "n1" },
    },
  ] as any);

  expect(items).toMatchObject([
    { offset: 2, displayTitle: "Standing desk height", tags: ["reference"] },
  ]);
});

test("deriveNotesList: failed analysis keeps the first-line fallback and surfaces the error", () => {
  const items = deriveNotesList([
    capturedEvent(1, "n1", "flaky note"),
    settledEvent(2, "n1", { status: "failed", error: "model unavailable" }),
  ] as any);
  expect(items).toMatchObject([{ displayTitle: "flaky note", analysisError: "model unavailable" }]);
});

test("deriveNotesList: duplicate captured events (idempotency retries) fold to one note", () => {
  const items = deriveNotesList([
    capturedEvent(1, "n1", "once"),
    capturedEvent(2, "n1", "once"),
  ] as any);
  expect(items).toHaveLength(1);
  expect(items[0]).toMatchObject({ offset: 1 });
});

test("deriveNotesList: updated overlays text, resets the derived title, ignores stale settlements", () => {
  const items = deriveNotesList([
    capturedEvent(1, "n1", "old text"),
    {
      type: "events.iterate.com/notes/updated",
      offset: 2,
      createdAt: "t2",
      payload: { noteKey: "n1", text: "new text" },
    },
    // A slow attempt from the pre-edit obligation (requestOffset 1) settles
    // AFTER the edit — its title came from the old text, so it must not win.
    settledEvent(3, "n1", {
      status: "succeeded",
      title: "Title for old text",
      tags: ["stale"],
      processedBy: "m",
    }),
  ] as any);
  expect(items).toMatchObject([
    { payload: { text: "new text" }, displayTitle: "new text", tags: [] },
  ]);

  const fresh = deriveNotesList([
    capturedEvent(1, "n1", "old text"),
    {
      type: "events.iterate.com/notes/updated",
      offset: 2,
      createdAt: "t2",
      payload: { noteKey: "n1", text: "new text" },
    },
    {
      ...settledEvent(3, "n1", {
        status: "succeeded",
        title: "Fresh title",
        tags: [],
        processedBy: "m",
      }),
      payload: {
        noteKey: "n1",
        requestOffset: 2,
        result: { status: "succeeded", title: "Fresh title", tags: [], processedBy: "m" },
      },
    },
  ] as any);
  expect(fresh).toMatchObject([{ displayTitle: "Fresh title" }]);
});

test("filterNotes: every term must match across title/text/filenames/tags", () => {
  const items = deriveNotesList([
    capturedEvent(1, "n1", "desk at 76cm", [
      {
        path: "/media/abc-office.jpg",
        filename: "office.jpg",
        contentType: "image/jpeg",
        width: 1,
        height: 1,
      },
    ]),
    capturedEvent(2, "n2", "milk and eggs"),
  ] as any);
  expect(filterNotes(items, "desk 76").map((item) => item.payload.noteKey)).toEqual(["n1"]);
  expect(filterNotes(items, "office.jpg").map((item) => item.payload.noteKey)).toEqual(["n1"]);
  expect(filterNotes(items, "desk milk")).toEqual([]);
  expect(filterNotes(items, "")).toHaveLength(2);
});

test("event builders: stable idempotency keys", () => {
  expect(
    buildCapturedEvent({ noteKey: "k1", text: "x", attachments: [], capturedOnDeviceAt: null }),
  ).toMatchObject({ idempotencyKey: "notes-captured-k1" });
  expect(buildDeletedEvent("k1")).toMatchObject({ idempotencyKey: "notes-deleted-k1" });
  expect(newNoteKey(1_000_000, "ab12")).toBe("lfls-ab12");
  expect(noteFirstLine("\n\n  first real line\nsecond")).toBe("first real line");
});
