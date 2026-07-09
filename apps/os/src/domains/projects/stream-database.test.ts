import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { StreamDatabase } from "./stream-database.ts";

/** Wrap node:sqlite as the DO's SqlStorage — only what StreamDatabase touches. */
function sqlStorage(): SqlStorage {
  const db = new DatabaseSync(":memory:");
  return {
    exec<T = unknown>(sql: string, ...bindings: (ArrayBuffer | null | number | string)[]) {
      const rows = db
        .prepare(sql)
        .all(...bindings.map((b) => (b instanceof ArrayBuffer ? new Uint8Array(b) : b))) as T[];
      return { toArray: () => rows };
    },
  } as unknown as SqlStorage;
}

describe("StreamDatabase", () => {
  it("indexes activity, keyed by path", () => {
    const db = new StreamDatabase(sqlStorage());
    db.touch("/a", "2026-01-01T00:00:00.000Z", "x", 1);
    db.touch("/b", "2026-01-02T00:00:00.000Z", "y", 3);
    expect(db.all()["/a"]).toMatchObject({ path: "/a", eventCount: 1, lastType: "x" });
    expect(db.all()["/b"]).toMatchObject({ eventCount: 3, lastType: "y" });
  });

  it("eventCount tracks max offset — idempotent on redelivery, grows with new events", () => {
    const db = new StreamDatabase(sqlStorage());
    db.touch("/a", "2026-01-02T00:00:00.000Z", "x", 5); // through offset 5
    db.touch("/a", "2026-01-01T00:00:00.000Z", "y", 5); // redelivery: same maxOffset, older at — no inflation, no regress
    expect(db.all()["/a"]).toMatchObject({
      lastActivityAt: "2026-01-02T00:00:00.000Z",
      lastType: "y",
      eventCount: 5,
    });
    db.touch("/a", "2026-01-03T00:00:00.000Z", "z", 8); // new events through offset 8
    expect(db.all()["/a"]).toMatchObject({
      eventCount: 8,
      lastActivityAt: "2026-01-03T00:00:00.000Z",
    });
  });

  it("swaps only the touched row's reference (copy-on-write)", () => {
    const db = new StreamDatabase(sqlStorage());
    db.touch("/a", "2026-01-01T00:00:00.000Z", "x", 1);
    db.touch("/b", "2026-01-01T00:00:00.000Z", "x", 1);
    const before = db.all();
    db.touch("/b", "2026-01-03T00:00:00.000Z", "x", 1);
    const after = db.all();
    expect(after["/a"]).toBe(before["/a"]); // untouched row keeps identity → diff bails, ⌘K row doesn't re-render
    expect(after["/b"]).not.toBe(before["/b"]);
    expect(after).not.toBe(before);
  });

  it("survives reconstruction from SQLite", () => {
    const sql = sqlStorage();
    const first = new StreamDatabase(sql);
    first.touch("/a", "2026-01-01T00:00:00.000Z", "x", 5);
    const reopened = new StreamDatabase(sql); // fresh projection loaded from the same SQLite
    expect(reopened.all()["/a"]).toMatchObject({ eventCount: 5 });
  });

  it("seeds missing catalog streams without clobbering real activity", () => {
    const db = new StreamDatabase(sqlStorage());
    db.touch("/a", "2026-05-01T00:00:00.000Z", "x", 4);
    db.seedMissing([
      { path: "/a", createdAt: "2020-01-01T00:00:00.000Z" }, // already indexed → activity wins
      { path: "/b", createdAt: "2026-01-01T00:00:00.000Z" }, // never touched → appears from catalog
    ]);
    expect(db.all()["/a"]).toMatchObject({
      eventCount: 4,
      lastActivityAt: "2026-05-01T00:00:00.000Z",
    });
    expect(db.all()["/b"]).toMatchObject({ path: "/b", eventCount: 0 });
  });

  it("reconciles streams added to the catalog AFTER the first call (not one-shot)", () => {
    const db = new StreamDatabase(sqlStorage());
    db.seedMissing([{ path: "/a", createdAt: "2026-01-01T00:00:00.000Z" }]);
    const first = db.all();
    // A stream created later: a subsequent assembly must backfill it.
    db.seedMissing([
      { path: "/a", createdAt: "2026-01-01T00:00:00.000Z" },
      { path: "/b", createdAt: "2026-02-01T00:00:00.000Z" },
    ]);
    expect(db.all()["/b"]).toMatchObject({ path: "/b", eventCount: 0 });
    expect(db.all()["/a"]).toBe(first["/a"]); // untouched row keeps identity → diff bails
    expect(db.all()).not.toBe(first); // but the map forked (a row was added)
  });

  it("backfills nothing → keeps the projection identity (diff bails, no re-render)", () => {
    const db = new StreamDatabase(sqlStorage());
    db.touch("/a", "2026-01-01T00:00:00.000Z", "x", 1);
    const before = db.all();
    db.seedMissing([{ path: "/a", createdAt: "2020-01-01T00:00:00.000Z" }]); // already present
    expect(db.all()).toBe(before);
  });
});
