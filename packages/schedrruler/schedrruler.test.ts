import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pluckFields } from "../../apps/os/backend/utils/test-helpers/test-utils.ts";
import { Schedrruler } from "./schedrruler";

const BASE_URL = "https://example.com";

class ArrayResult {
  constructor(private readonly rows: any[]) {}
  toArray() {
    return this.rows;
  }
  one() {
    return this.rows[0];
  }
}

class FakeSql {
  private events: Array<{ id: number; ts: number; type: string; rule_key: string | null; payload: string }> = [];
  private next = new Map<string, number | null>();
  private lastId = 0;

  exec(query: string, ...params: any[]): any {
    const normalized = query.trim().replace(/\s+/g, " ");
    const upper = normalized.toUpperCase();

    if (upper.startsWith("CREATE TABLE") || upper.startsWith("CREATE INDEX")) {
      return this;
    }

    if (upper.startsWith("BEGIN") || upper.startsWith("COMMIT") || upper.startsWith("ROLLBACK")) {
      return this;
    }

    if (/^INSERT INTO EVENTS/i.test(normalized)) {
      const [ts, type, ruleKey, payload] = params;
      this.events.push({
        id: ++this.lastId,
        ts: Number(ts),
        type,
        rule_key: ruleKey ?? null,
        payload,
      });
      return this;
    }

    if (/^INSERT INTO NEXT/i.test(normalized)) {
      const [key, ts] = params;
      this.next.set(String(key), ts == null ? null : Number(ts));
      return this;
    }

    if (/^DELETE FROM NEXT WHERE RULE_KEY = \?/i.test(normalized)) {
      const [key] = params;
      this.next.delete(String(key));
      return this;
    }

    if (/^SELECT ID, TS, TYPE, RULE_KEY, PAYLOAD FROM EVENTS/i.test(normalized)) {
      const limit = Number(params[0] ?? this.events.length);
      const rows = [...this.events]
        .sort((a, b) => (b.ts - a.ts) || (b.id - a.id))
        .slice(0, limit)
        .map(({ id, ts, type, rule_key, payload }) => ({ id, ts, type, rule_key, payload }));
      return new ArrayResult(rows);
    }

    if (/^SELECT PAYLOAD FROM EVENTS/i.test(normalized)) {
      const trackedTypes = new Set([
        "directive_add",
        "directive_change",
        "directive_delete",
        "rule_add",
        "rule_change",
        "rule_delete",
      ]);
      const rows = [...this.events]
        .filter((event) => trackedTypes.has(event.type))
        .sort((a, b) => (a.ts - b.ts) || (a.id - b.id))
        .map(({ payload }) => ({ payload }));
      return new ArrayResult(rows);
    }

    if (/^SELECT RULE_KEY FROM NEXT WHERE NEXT_TS IS NOT NULL AND NEXT_TS <= \?/i.test(normalized)) {
      const [limit] = params;
      const rows = [...this.next.entries()]
        .filter(([, ts]) => ts != null && Number(ts) <= Number(limit))
        .sort((a, b) => (a[1]! - b[1]!))
        .map(([rule_key]) => ({ rule_key }));
      return new ArrayResult(rows);
    }

    if (/^SELECT RULE_KEY FROM NEXT$/i.test(normalized)) {
      const rows = [...this.next.keys()].map((rule_key) => ({ rule_key }));
      return new ArrayResult(rows);
    }

    if (/^SELECT RULE_KEY, NEXT_TS FROM NEXT$/i.test(normalized)) {
      const rows = [...this.next.entries()].map(([rule_key, next_ts]) => ({ rule_key, next_ts }));
      return new ArrayResult(rows);
    }

    if (/^SELECT MIN\(NEXT_TS\) AS TS FROM NEXT/i.test(normalized)) {
      const values = [...this.next.values()].filter((value): value is number => value != null);
      const min = values.length > 0 ? Math.min(...values) : null;
      return { one: () => ({ ts: min }) };
    }

    throw new Error(`Unsupported SQL in test stub: ${normalized}`);
  }
}

function createState() {
  const sql = new FakeSql();
  let alarm: number | null = null;
  return {
    storage: {
      sql,
      setAlarm(value: number) {
        alarm = value;
      },
      deleteAlarm() {
        alarm = null;
      },
      get alarm() {
        return alarm;
      },
    },
    blockConcurrencyWhile<T>(cb: () => Promise<T> | T) {
      return Promise.resolve(cb());
    },
  } satisfies { storage: { sql: FakeSql; setAlarm(value: number): void; deleteAlarm(): void; alarm: number | null }; blockConcurrencyWhile<T>(cb: () => Promise<T> | T): Promise<T>; };
}

function makeRequest(path: string, init?: RequestInit) {
  return new Request(new URL(path, BASE_URL), init);
}

describe("Schedrruler durable object", () => {
  let schedrruler: Schedrruler;
  let state: ReturnType<typeof createState>;
  const initial = new Date("2024-01-01T00:00:00Z");

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(initial);
    state = createState();
    schedrruler = new Schedrruler(state as any, {});
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function fetchDo(path: string, init?: RequestInit) {
    return schedrruler.fetch(makeRequest(path, init));
  }

  it("runs RRULE directives and records the result", async () => {
    await fetchDo("/events", {
      method: "POST",
      body: JSON.stringify({
        type: "directive_add",
        key: "scheduled",
        instruction: { kind: "rrule", rrule: "FREQ=SECONDLY;COUNT=2" },
        method: "log",
      }),
      headers: { "content-type": "application/json" },
    });

    vi.setSystemTime(new Date(initial.getTime() + 2_000));
    await schedrruler.alarm();

    const response = await fetchDo("/events?limit=5");
    const rows = (await response.json()) as Array<Record<string, any>>;
    const summary = pluckFields(
      rows.map((row) => ({ ...row, payload: JSON.parse(row.payload) })),
      ["type", "rule_key", "payload.instruction.kind", "payload.result.method", "payload.result.ok"],
      { stringifyColumns: true },
    ) as string;
    const lines = summary
      .split("\n")
      .filter(Boolean)
      .sort();

    expect(lines).toMatchInlineSnapshot(`
      [
        "[\"directive_add\",\"scheduled\",\"rrule\",null,null]",
        "[\"invoke\",\"scheduled\",null,\"log\",true]",
      ]
    `);
  });

  it("supports manual invocations via events", async () => {
    await fetchDo("/events", {
      method: "POST",
      body: JSON.stringify({
        type: "directive_add",
        key: "manual",
        instruction: { kind: "rrule", rrule: "FREQ=DAILY" },
        method: "log",
      }),
      headers: { "content-type": "application/json" },
    });

    await fetchDo("/events", {
      method: "POST",
      body: JSON.stringify({ type: "invoke", key: "manual", mode: "manual" }),
      headers: { "content-type": "application/json" },
    });

    const response = await fetchDo("/events?limit=5");
    const rows = (await response.json()) as Array<Record<string, any>>;
    const summary = pluckFields(
      rows.map((row) => ({ ...row, payload: JSON.parse(row.payload) })),
      ["type", "rule_key", "payload.mode", "payload.result.method", "payload.result.ok"],
      { stringifyColumns: true },
    ) as string;
    const lines = summary
      .split("\n")
      .filter(Boolean)
      .sort();

    expect(lines).toMatchInlineSnapshot(`
      [
        "[\"directive_add\",\"manual\",null,null,null]",
        "[\"invoke\",\"manual\",\"manual\",\"log\",true]",
        "[\"invoke\",\"manual\",\"manual\",null,null]",
      ]
    `);
  });

  it("supports once directives for one-off timers", async () => {
    await fetchDo("/events", {
      method: "POST",
      body: JSON.stringify({
        type: "directive_add",
        key: "launch",
        instruction: { kind: "once", at: new Date(initial.getTime() - 5_000).toISOString() },
        method: "log",
      }),
      headers: { "content-type": "application/json" },
    });

    await schedrruler.alarm();

    const response = await fetchDo("/events?limit=5");
    const rows = (await response.json()) as Array<Record<string, any>>;
    const summary = pluckFields(
      rows.map((row) => ({ ...row, payload: JSON.parse(row.payload) })),
      ["type", "rule_key", "payload.instruction.kind", "payload.result.method", "payload.result.ok"],
      { stringifyColumns: true },
    ) as string;
    const lines = summary
      .split("\n")
      .filter(Boolean)
      .sort();

    expect(lines).toMatchInlineSnapshot(`
      [
        "[\"directive_add\",\"launch\",\"once\",null,null]",
        "[\"invoke\",\"launch\",null,\"log\",true]",
      ]
    `);

    expect(state.storage.alarm).toBeNull();
  });

  it("computes cron directives using cron-parser", async () => {
    await fetchDo("/events", {
      method: "POST",
      body: JSON.stringify({
        type: "directive_add",
        key: "cron", 
        instruction: { kind: "cron", cron: "*/1 * * * * *" },
        method: "log",
      }),
      headers: { "content-type": "application/json" },
    });

    vi.setSystemTime(new Date(initial.getTime() + 1_500));
    await schedrruler.alarm();

    const response = await fetchDo("/events?limit=5");
    const rows = (await response.json()) as Array<Record<string, any>>;
    const summary = pluckFields(
      rows.map((row) => ({ ...row, payload: JSON.parse(row.payload) })),
      ["type", "rule_key", "payload.instruction.kind", "payload.result.method", "payload.result.ok"],
      { stringifyColumns: true },
    ) as string;
    const lines = summary
      .split("\n")
      .filter(Boolean)
      .sort();

    expect(lines).toMatchInlineSnapshot(`
      [
        "[\"directive_add\",\"cron\",\"cron\",null,null]",
        "[\"invoke\",\"cron\",null,\"log\",true]",
      ]
    `);
  });
});
