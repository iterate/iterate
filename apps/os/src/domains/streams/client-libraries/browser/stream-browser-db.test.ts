// Regression tests for StreamBrowserDatabase's change-notification pass.
//
// The key regression: one notifyChanged() re-runs every live query, and each
// result used to notify React as soon as its own worker round-trip resolved.
// Views composing several queries over the same database (the agent feed's
// item count + visible rows + live processor state) would render inconsistent
// intermediate frames — e.g. the settled feed row already counted while the
// live activity still showed the same content — visible as flicker on every
// live→settled handoff. The pass must apply every refreshed snapshot first and
// only then notify, so React commits one consistent frame.

import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { StreamBrowserDatabase, type SqlValue } from "./stream-browser-db.ts";

// node:sqlite rejects the number[] member of SqlValue; these tests never use it.
type ScalarSqlValue = Exclude<SqlValue, number[]>;

type WorkerRequest = {
  id: number;
  op: string;
  sql?: string;
  params?: SqlValue[];
  statements?: { sql: string; params?: SqlValue[] }[];
  transaction?: boolean;
};

/**
 * The real stream-db worker owns a wa-sqlite database and answers one message
 * per request; this stand-in answers from an in-memory node:sqlite database
 * with the same shape. Each response lands in its own macrotask (setTimeout 0,
 * FIFO) — the exact timing that let per-query notifications tear.
 */
class FakeStreamDbWorker {
  onmessage: ((event: { data: unknown }) => void) | null = null;
  #db = new DatabaseSync(":memory:");
  #listeners = new Set<(event: { data: unknown }) => void>();

  postMessage(message: WorkerRequest) {
    setTimeout(() => {
      let response: { id: number; ok: boolean; result?: unknown; error?: string };
      try {
        response = { id: message.id, ok: true, result: this.#handle(message) };
      } catch (error) {
        response = { id: message.id, ok: false, error: String(error) };
      }
      const event = { data: response };
      this.onmessage?.(event);
      for (const listener of this.#listeners) listener(event);
    }, 0);
  }

  #handle(message: WorkerRequest): unknown {
    switch (message.op) {
      case "init":
      case "close":
        return undefined;
      case "exec":
        return this.#db
          .prepare(message.sql ?? "")
          .all(...((message.params ?? []) as ScalarSqlValue[]));
      case "batch": {
        if (message.transaction) this.#db.exec("BEGIN");
        try {
          for (const statement of message.statements ?? []) {
            this.#db.prepare(statement.sql).run(...((statement.params ?? []) as ScalarSqlValue[]));
          }
          if (message.transaction) this.#db.exec("COMMIT");
        } catch (error) {
          if (message.transaction) this.#db.exec("ROLLBACK");
          throw error;
        }
        return undefined;
      }
      default:
        throw new Error(`fake stream-db worker: unknown op ${message.op}`);
    }
  }

  addEventListener(_type: string, listener: (event: { data: unknown }) => void) {
    this.#listeners.add(listener);
  }

  removeEventListener(_type: string, listener: (event: { data: unknown }) => void) {
    this.#listeners.delete(listener);
  }

  terminate() {
    this.#listeners.clear();
  }
}

async function waitFor(condition: () => boolean, label: string) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${label}`);
}

function createDatabase() {
  vi.stubGlobal("Worker", FakeStreamDbWorker);
  return new StreamBrowserDatabase("prj_test", "/agents/demo");
}

let database: StreamBrowserDatabase | undefined;

afterEach(() => {
  database?.dispose();
  database = undefined;
  vi.unstubAllGlobals();
});

it("applies every live query before notifying any listener for one change", async () => {
  database = createDatabase();
  await database.exec(
    `CREATE TABLE feed_items (local_index INTEGER PRIMARY KEY, data TEXT NOT NULL)`,
  );
  await database.exec(`CREATE TABLE activity (label TEXT NOT NULL)`);
  await database.exec(`INSERT INTO activity (label) VALUES ('live')`);

  const countHandle = database.query(`SELECT COUNT(*) AS count FROM feed_items`, []);
  const stateHandle = database.query(`SELECT label FROM activity`, []);
  // Every notification records the pair of snapshots a subscriber would render
  // from — the flicker is any frame where they disagree about the handoff.
  const observedFrames: string[] = [];
  const recordFrame = () =>
    observedFrames.push(
      `${countHandle.getSnapshot().data[0]?.count}:${stateHandle.getSnapshot().data[0]?.label}`,
    );
  countHandle.subscribe(recordFrame);
  stateHandle.subscribe(recordFrame);

  await waitFor(
    () => countHandle.getSnapshot().status === "ok" && stateHandle.getSnapshot().status === "ok",
    "initial query results",
  );
  observedFrames.length = 0;

  // The settle handoff: the feed row lands and the live activity clears in one
  // write batch, followed by a single change notification.
  await database.batch(
    [
      { sql: `INSERT INTO feed_items (local_index, data) VALUES (0, 'message')` },
      { sql: `UPDATE activity SET label = 'settled'` },
    ],
    { transaction: true },
  );
  database.notifyChanged();

  await waitFor(() => observedFrames.length >= 2, "both listeners to observe the change");
  // Let any straggling notification land before asserting.
  await new Promise((resolve) => setTimeout(resolve, 25));

  expect(observedFrames.length).toBeGreaterThanOrEqual(2);
  for (const frame of observedFrames) {
    expect(frame).toBe("1:settled");
  }
});

it("does not notify queries whose results did not change", async () => {
  database = createDatabase();
  await database.exec(`CREATE TABLE feed_items (local_index INTEGER PRIMARY KEY)`);
  await database.exec(`CREATE TABLE unrelated (value TEXT NOT NULL)`);
  await database.exec(`INSERT INTO unrelated (value) VALUES ('constant')`);

  const changingHandle = database.query(`SELECT COUNT(*) AS count FROM feed_items`, []);
  const constantHandle = database.query(`SELECT value FROM unrelated`, []);
  let changingNotifications = 0;
  let constantNotifications = 0;
  changingHandle.subscribe(() => (changingNotifications += 1));
  constantHandle.subscribe(() => (constantNotifications += 1));

  await waitFor(
    () =>
      changingHandle.getSnapshot().status === "ok" && constantHandle.getSnapshot().status === "ok",
    "initial query results",
  );
  const changingBaseline = changingNotifications;
  const constantBaseline = constantNotifications;

  await database.exec(`INSERT INTO feed_items (local_index) VALUES (0)`);
  database.notifyChanged();

  await waitFor(() => changingNotifications > changingBaseline, "the changed query to notify");
  await new Promise((resolve) => setTimeout(resolve, 25));
  expect(constantNotifications).toBe(constantBaseline);
});
