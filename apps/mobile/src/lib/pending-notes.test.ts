import { expect, test } from "vitest";
import {
  addPendingNote,
  drainPendingNotes,
  readPendingNotes,
  type PendingNote,
  type PendingNotesStorage,
} from "./pending-notes.ts";

function memoryStorage(initial: Record<string, string> = {}): PendingNotesStorage {
  const map = new Map(Object.entries(initial));
  return {
    getItem: async (key) => map.get(key) || null,
    setItem: async (key, value) => void map.set(key, value),
  };
}

const note = (noteKey: string, text: string): PendingNote => ({
  noteKey,
  text,
  capturedOnDeviceAt: "2026-08-12T09:00:00.000Z",
  attachments: [],
});

test("add + read round-trips and dedupes by noteKey", async () => {
  const storage = memoryStorage();
  await addPendingNote(storage, note("n1", "first"));
  await addPendingNote(storage, note("n2", "second"));
  await addPendingNote(storage, note("n1", "retried save"));
  expect(await readPendingNotes(storage)).toMatchObject([
    { noteKey: "n1", text: "first" },
    { noteKey: "n2", text: "second" },
  ]);
});

test("corrupted storage reads as empty instead of crashing capture", async () => {
  expect(await readPendingNotes(memoryStorage({ "iterate.pendingNotes": "{not json" }))).toEqual(
    [],
  );
  expect(
    await readPendingNotes(memoryStorage({ "iterate.pendingNotes": '{"an":"object"}' })),
  ).toEqual([]);
});

test("drain stores oldest first and removes each note as it lands", async () => {
  const storage = memoryStorage();
  await addPendingNote(storage, note("n1", "first"));
  await addPendingNote(storage, note("n2", "second"));
  const stored: string[] = [];
  const result = await drainPendingNotes(storage, async (pending) => {
    stored.push(pending.noteKey);
  });
  expect(result).toEqual({ stored: 2, remaining: 0, error: null });
  expect(stored).toEqual(["n1", "n2"]);
  expect(await readPendingNotes(storage)).toEqual([]);
});

test("a mid-drain failure keeps the unstored tail pending", async () => {
  const storage = memoryStorage();
  await addPendingNote(storage, note("n1", "lands"));
  await addPendingNote(storage, note("n2", "fails"));
  await addPendingNote(storage, note("n3", "never attempted"));
  const result = await drainPendingNotes(storage, async (pending) => {
    if (pending.noteKey !== "n1") throw new Error("network gone");
  });
  expect(result).toEqual({ stored: 1, remaining: 2, error: "network gone" });
  expect(await readPendingNotes(storage)).toMatchObject([{ noteKey: "n2" }, { noteKey: "n3" }]);
});
