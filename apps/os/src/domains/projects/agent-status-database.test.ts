import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { AgentStatusDatabase } from "./agent-status-database.ts";

/** Wrap node:sqlite as the DO's SqlStorage — only what AgentStatusDatabase touches. */
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

const AT = "2026-07-14T12:00:00.000Z";

describe("AgentStatusDatabase", () => {
  it("merges busy and authored patches into one record per agent", () => {
    const db = new AgentStatusDatabase(sqlStorage());
    db.touch({
      path: "/agents/main",
      events: [
        { payload: { busy: true, sinceOffset: 3 }, offset: 4, createdAt: AT },
        {
          payload: { title: "Lisbon trip", shortStatus: "comparing flights" },
          offset: 7,
          createdAt: AT,
        },
      ],
    });
    expect(db.all()["/agents/main"]).toMatchObject({
      path: "/agents/main",
      status: {
        busy: true,
        sinceOffset: 3,
        title: "Lisbon trip",
        shortStatus: "comparing flights",
      },
      lastEventOffset: 7,
    });
  });

  it("ignores redelivered events and stale busy patches", () => {
    const db = new AgentStatusDatabase(sqlStorage());
    db.touch({
      path: "/agents/main",
      events: [{ payload: { busy: true, sinceOffset: 9 }, offset: 10, createdAt: AT }],
    });
    const before = db.all();
    // Exact redelivery: at-or-below lastEventOffset folds to nothing.
    db.touch({
      path: "/agents/main",
      events: [{ payload: { busy: true, sinceOffset: 9 }, offset: 10, createdAt: AT }],
    });
    expect(db.all()).toBe(before);
    // A debounce timer's stale idle (older sinceOffset, newer event offset):
    // the offset advances, the busy value does not.
    db.touch({
      path: "/agents/main",
      events: [{ payload: { busy: false, sinceOffset: 5 }, offset: 11, createdAt: AT }],
    });
    expect(db.all()["/agents/main"]).toMatchObject({
      status: { busy: true, sinceOffset: 9 },
      lastEventOffset: 11,
    });
  });

  it("skips malformed payloads without losing the rest of the batch", () => {
    const db = new AgentStatusDatabase(sqlStorage());
    db.touch({
      path: "/agents/main",
      events: [
        { payload: { busy: "yes" }, offset: 1, createdAt: AT },
        { payload: { note: "a helpful agent" }, offset: 2, createdAt: AT },
      ],
    });
    expect(db.all()["/agents/main"]).toMatchObject({
      status: { note: "a helpful agent" },
      lastEventOffset: 2,
    });
  });

  it("swaps only the touched row's reference (copy-on-write) and survives reload", () => {
    const sql = sqlStorage();
    const db = new AgentStatusDatabase(sql);
    db.touch({
      path: "/agents/a",
      events: [{ payload: { title: "A" }, offset: 1, createdAt: AT }],
    });
    db.touch({
      path: "/agents/b",
      events: [{ payload: { title: "B" }, offset: 1, createdAt: AT }],
    });
    const before = db.all();
    db.touch({
      path: "/agents/b",
      events: [{ payload: { busy: true, sinceOffset: 2 }, offset: 3, createdAt: AT }],
    });
    const after = db.all();
    expect(after["/agents/a"]).toBe(before["/agents/a"]);
    expect(after["/agents/b"]).not.toBe(before["/agents/b"]);

    // A fresh instance over the same SQLite (a DO restart) reloads the rows.
    const reloaded = new AgentStatusDatabase(sql);
    expect(reloaded.all()["/agents/b"]).toMatchObject({
      status: { title: "B", busy: true, sinceOffset: 2 },
      lastEventOffset: 3,
    });
  });
});
