import { expect, test } from "vitest";
import {
  buildCapturedEvent,
  buildDeletedEvent,
  composeNoteFile,
  deriveNotesList,
  filterNotes,
  latestNoteFactOffset,
  noteFilePath,
  parseNoteFile,
  parseNoteListItem,
} from "./notes.ts";

test("noteFilePath: sortable, colon-free, deterministic", () => {
  expect(noteFilePath("2026-08-12T15:01:20.841Z", "x7ab")).toBe(
    "/repos/notes/2026-08-12T15-01-20-841Z-x7ab.md",
  );
});

test("frontmatter round-trips and preserves foreign keys", () => {
  const composed = composeNoteFile(
    { capturedAt: "2026-08-12T15:01:20.841Z", mood: "curious" },
    "the body\ntwo lines",
  );
  expect(parseNoteFile(composed)).toEqual({
    frontmatter: { capturedAt: "2026-08-12T15:01:20.841Z", mood: "curious" },
    body: "the body\ntwo lines",
  });
  expect(parseNoteFile("no frontmatter")).toEqual({ frontmatter: {}, body: "no frontmatter" });
  expect(parseNoteFile("---\n: broken [\n---\nbody")).toMatchObject({ frontmatter: {} });
});

test("parseNoteListItem: analyzed file → title/tags/attachments; raw file → first-line fallback", () => {
  const analyzed = parseNoteListItem(
    "/repos/notes/2026-08-12T15-01-20-841Z-x7ab.md",
    composeNoteFile(
      {
        capturedAt: "2026-08-12T15:01:20.841Z",
        title: "Standing desk height",
        tags: ["reference", 42],
        attachments: [
          {
            path: "/media/abc-office.jpg",
            filename: "office.jpg",
            contentType: "image/jpeg",
            width: 1,
            height: 1,
          },
          { broken: true },
        ],
      },
      "desk at 76cm",
    ),
  );
  expect(analyzed).toMatchObject({
    capturedAt: "2026-08-12T15:01:20.841Z",
    displayTitle: "Standing desk height",
    tags: ["reference"], // non-strings dropped
    attachments: [{ filename: "office.jpg" }], // malformed dropped
    text: "desk at 76cm",
  });

  const raw = parseNoteListItem("/repos/notes/2026-08-12T15-01-20-841Z-x7ab.md", "just text\nmore");
  expect(raw).toMatchObject({
    displayTitle: "just text",
    // capturedAt recovered from the filename stamp when frontmatter lacks it
    capturedAt: "2026-08-12T15:01:20.841Z",
    title: "",
    tags: [],
  });
});

test("deriveNotesList: newest first by stamped filename; nulls and non-note files skipped", () => {
  const items = deriveNotesList({
    "/repos/notes/2026-08-12T10-00-00-000Z-aaaa.md": "older",
    "/repos/notes/2026-08-12T11-00-00-000Z-bbbb.md": "newer",
    "/repos/notes/2026-08-12T12-00-00-000Z-gone.md": null,
    // The notes repo is born with the config template in it (platform quirk)
    // — template files must never render as notes.
    "/repos/notes/ONBOARDING.md": "# Onboarding Agent",
    "/repos/notes/AGENTS.md": "# Project configuration",
  });
  expect(items.map((item) => item.text)).toEqual(["newer", "older"]);
});

test("filterNotes: every term must match across title/text/filenames/tags", () => {
  const items = deriveNotesList({
    "/repos/notes/2026-08-12T10-00-00-000Z-aaaa.md": composeNoteFile(
      {
        title: "Standing desk",
        tags: ["reference"],
        attachments: [
          {
            path: "/media/x-office.jpg",
            filename: "office.jpg",
            contentType: "image/jpeg",
            width: 1,
            height: 1,
          },
        ],
      },
      "desk at 76cm",
    ),
    "/repos/notes/2026-08-12T11-00-00-000Z-bbbb.md": "milk and eggs",
  });
  expect(filterNotes(items, "desk 76").map((item) => item.title)).toEqual(["Standing desk"]);
  expect(filterNotes(items, "office.jpg")).toHaveLength(1);
  expect(filterNotes(items, "reference")).toHaveLength(1);
  expect(filterNotes(items, "desk milk")).toEqual([]);
  expect(filterNotes(items, "")).toHaveLength(2);
});

test("event builders + fact offset", () => {
  const path = "/repos/notes/2026-08-12T15-01-20-841Z-x7ab.md";
  expect(buildCapturedEvent(path)).toMatchObject({ idempotencyKey: `notes-captured-${path}` });
  expect(buildDeletedEvent(path)).toMatchObject({ idempotencyKey: `notes-deleted-${path}` });
  expect(latestNoteFactOffset([{ offset: 3 }, { offset: 9 }, { offset: 5 }] as any)).toBe(9);
  expect(latestNoteFactOffset([])).toBe(0);
});
