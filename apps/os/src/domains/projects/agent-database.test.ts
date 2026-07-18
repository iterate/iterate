import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  AGENT_BINDING_SET_EVENT_TYPE,
  AGENT_METADATA_CHANGED_EVENT_TYPE,
  AGENT_RUNTIME_CHANGED_EVENT_TYPE,
  AGENT_WAITING_CLEARED_EVENT_TYPE,
  ZERO_AGENT_RUNTIME,
} from "@iterate-com/shared/agent-events";
import { AgentDatabase } from "./agent-database.ts";

function sqlStorage(): SqlStorage {
  const db = new DatabaseSync(":memory:");
  return {
    exec<T = unknown>(sql: string, ...bindings: (ArrayBuffer | null | number | string)[]) {
      const rows = db
        .prepare(sql)
        .all(
          ...bindings.map((binding) =>
            binding instanceof ArrayBuffer ? new Uint8Array(binding) : binding,
          ),
        ) as T[];
      return { toArray: () => rows };
    },
  } as unknown as SqlStorage;
}

const AT = "2026-07-14T12:00:00.000Z";
const LATER = "2026-07-14T12:01:00.000Z";
const event = (type: string, payload: unknown, offset: number, createdAt = AT) => ({
  type,
  payload,
  offset,
  createdAt,
});
const created = (offset: number, createdAt = AT) =>
  event("events.iterate.com/agent/created", {}, offset, createdAt);

describe("AgentDatabase", () => {
  it("creates every agent before it has metadata", () => {
    const db = new AgentDatabase(sqlStorage());
    db.touch({
      path: "/agents/main",
      events: [created(1)],
    });
    expect(db.all()["/agents/main"]).toEqual({
      path: "/agents/main",
      metadata: { pinned: false },
      runtime: ZERO_AGENT_RUNTIME,
      timestamps: { createdAt: AT, lastWorkAt: AT },
    });
  });

  it("seeds quiet agents and lets the direct created fact win", () => {
    const sql = sqlStorage();
    const db = new AgentDatabase(sql);
    db.seedMissing([{ path: "/agents/main", createdAt: LATER }]);
    db.touch({
      path: "/agents/main",
      events: [created(1, AT)],
    });
    expect(db.all()["/agents/main"]!.timestamps.createdAt).toBe(AT);
    expect(new AgentDatabase(sql).all()).toEqual(db.all());
  });

  it("rejects a second direct creation without changing the materialized row", () => {
    const db = new AgentDatabase(sqlStorage());
    db.touch({
      path: "/agents/main",
      events: [created(1)],
    });
    const before = db.all();

    expect(() =>
      db.touch({
        path: "/agents/main",
        events: [created(2, LATER)],
      }),
    ).toThrow("more than one agent/created");
    expect(db.all()).toBe(before);
  });

  it("applies metadata patch semantics and meaningful timestamps", () => {
    const db = new AgentDatabase(sqlStorage());
    db.touch({
      path: "/agents/main",
      events: [
        created(1),
        event(
          AGENT_METADATA_CHANGED_EVENT_TYPE,
          { title: "Research", activity: "Reading papers", pinned: true },
          2,
          LATER,
        ),
      ],
    });
    const record = db.all()["/agents/main"]!;
    expect(record.metadata).toEqual({
      title: "Research",
      activity: "Reading papers",
      pinned: true,
    });
    expect(record.timestamps).toMatchObject({
      metadataUpdatedAt: LATER,
      activityUpdatedAt: LATER,
      lastWorkAt: LATER,
    });

    const before = db.all();
    db.touch({
      path: "/agents/main",
      events: [event(AGENT_METADATA_CHANGED_EVENT_TYPE, { pinned: true }, 3, LATER)],
    });
    expect(db.all()).toBe(before);
  });

  it("does not let a delayed wake clear erase a newer wait", () => {
    const db = new AgentDatabase(sqlStorage());
    db.touch({
      path: "/agents/main",
      events: [
        created(1),
        event(AGENT_METADATA_CHANGED_EVENT_TYPE, { waitingFor: "user_input" }, 2),
        event(AGENT_METADATA_CHANGED_EVENT_TYPE, { waitingFor: "timer" }, 4),
        event(AGENT_WAITING_CLEARED_EVENT_TYPE, { throughOffset: 3 }, 5),
      ],
    });
    expect(db.all()["/agents/main"]!.metadata.waitingFor).toBe("timer");
    db.touch({
      path: "/agents/main",
      events: [event(AGENT_WAITING_CLEARED_EVENT_TYPE, { throughOffset: 6 }, 7, LATER)],
    });
    expect(db.all()["/agents/main"]!.metadata.waitingFor).toBeUndefined();
  });

  it("rejects stale runtime, folds a binding snapshot, and preserves other row identities", () => {
    const db = new AgentDatabase(sqlStorage());
    for (const path of ["/agents/a", "/agents/b"]) {
      db.touch({ path, events: [created(1)] });
    }
    const before = db.all();
    const active = {
      triggers: { pending: 0, runnable: 0 },
      llmRequests: { scheduled: 0, requested: 0, started: 1 },
      runningScripts: 0,
    };
    db.touch({
      path: "/agents/b",
      events: [
        event(AGENT_RUNTIME_CHANGED_EVENT_TYPE, { sinceOffset: 8, runtime: active }, 9, LATER),
        event(
          AGENT_RUNTIME_CHANGED_EVENT_TYPE,
          { sinceOffset: 5, runtime: ZERO_AGENT_RUNTIME },
          10,
          LATER,
        ),
        event(
          AGENT_BINDING_SET_EVENT_TYPE,
          {
            type: "github_pull_request",
            connection: "github",
            installationId: "123",
            owner: "iterate",
            repo: "iterate",
            number: 42,
          },
          11,
          LATER,
        ),
      ],
    });
    expect(db.all()["/agents/a"]).toBe(before["/agents/a"]);
    expect(db.all()["/agents/b"]).toMatchObject({ runtime: active });
    expect(db.all()["/agents/b"]!.binding).toMatchObject({
      type: "github_pull_request",
      number: 42,
    });
  });

  it("rejects conflicting snapshots for the same runtime generation", () => {
    const db = new AgentDatabase(sqlStorage());
    const active = {
      triggers: { pending: 0, runnable: 0 },
      llmRequests: { scheduled: 0, requested: 0, started: 1 },
      runningScripts: 0,
    };
    db.touch({
      path: "/agents/main",
      events: [
        created(1),
        event(AGENT_RUNTIME_CHANGED_EVENT_TYPE, { sinceOffset: 8, runtime: active }, 2),
      ],
    });
    const before = db.all();

    expect(() =>
      db.touch({
        path: "/agents/main",
        events: [
          event(
            AGENT_RUNTIME_CHANGED_EVENT_TYPE,
            { sinceOffset: 8, runtime: ZERO_AGENT_RUNTIME },
            3,
          ),
        ],
      }),
    ).toThrow("Conflicting agent runtime snapshots");
    expect(db.all()).toBe(before);
  });

  it("is idempotent under committed batch redelivery", () => {
    const db = new AgentDatabase(sqlStorage());
    const input = {
      path: "/agents/main",
      events: [created(1), event(AGENT_METADATA_CHANGED_EVENT_TYPE, { title: "Main" }, 2)],
    };
    db.touch(input);
    const before = db.all();
    db.touch(input);
    expect(db.all()).toBe(before);
  });

  it("fails loudly when durable projection state is invalid", () => {
    const sql = sqlStorage();
    new AgentDatabase(sql);
    sql.exec(
      `INSERT INTO agents
       (path, record, last_event_offset, runtime_since_offset, waiting_for_since_offset)
       VALUES (?, ?, ?, ?, ?)`,
      "/agents/broken",
      JSON.stringify({ path: "/agents/broken", metadata: { pinned: "not-a-boolean" } }),
      1,
      0,
      null,
    );

    expect(() => new AgentDatabase(sql)).toThrow();
  });

  it("ignores malformed projection lookalikes with the same semantics as stream processors", () => {
    const db = new AgentDatabase(sqlStorage());

    db.touch({
      path: "/agents/phantom",
      events: [event("events.iterate.com/agent/created", { unexpected: true }, 1)],
    });
    expect(db.all()).toEqual({});

    db.touch({
      path: "/agents/main",
      events: [created(1)],
    });
    const before = db.all();

    db.touch({
      path: "/agents/main",
      events: [
        event("events.iterate.com/agent/created", { unexpected: true }, 2),
        event(AGENT_METADATA_CHANGED_EVENT_TYPE, { pinned: "yes" }, 3),
        event(AGENT_RUNTIME_CHANGED_EVENT_TYPE, { sinceOffset: -1 }, 4),
        event(AGENT_WAITING_CLEARED_EVENT_TYPE, { throughOffset: 0 }, 5),
        event(AGENT_BINDING_SET_EVENT_TYPE, { type: "unknown" }, 6),
      ],
    });
    expect(db.all()).toBe(before);

    db.touch({
      path: "/agents/main",
      events: [event(AGENT_METADATA_CHANGED_EVENT_TYPE, { title: "Still healthy" }, 7)],
    });
    expect(db.all()["/agents/main"]!.metadata.title).toBe("Still healthy");
  });

  it("rejects projection facts that precede explicit agent creation", () => {
    const db = new AgentDatabase(sqlStorage());

    expect(() =>
      db.touch({
        path: "/agents/unborn",
        events: [event(AGENT_METADATA_CHANGED_EVENT_TYPE, { title: "Impossible" }, 1)],
      }),
    ).toThrow("before agent/created");
    expect(db.all()).toEqual({});
  });

  it.each(["/agents/Uppercase", "/agents/two//segments", "/agents/trailing/", "/agents/has space"])(
    "rejects a direct agent/created event on non-canonical path %j",
    (path) => {
      const db = new AgentDatabase(sqlStorage());
      expect(() => db.touch({ path, events: [created(1)] })).toThrow(
        "agent path must be canonical",
      );
      expect(db.all()).toEqual({});
    },
  );

  it("rejects non-canonical quiet-agent seeds", () => {
    const db = new AgentDatabase(sqlStorage());
    expect(() => db.seedMissing([{ path: "/agents/bad path", createdAt: AT }])).toThrow(
      "agent path must be canonical",
    );
    expect(db.all()).toEqual({});
  });

  it("updates one row in a 5,000-agent projection within the live-diff budget", () => {
    const db = new AgentDatabase(sqlStorage());
    const seeds = Array.from({ length: 5_000 }, (_, index) => ({
      path: `/agents/load-${String(index).padStart(4, "0")}`,
      createdAt: AT,
    }));
    db.seedMissing(seeds);
    const before = db.all();
    const target = seeds.at(-1)!.path;

    const startedAt = performance.now();
    db.touch({
      path: target,
      events: [event(AGENT_METADATA_CHANGED_EVENT_TYPE, { activity: "One changed row" }, 1)],
    });
    const updateMs = performance.now() - startedAt;
    const after = db.all();

    expect(updateMs).toBeLessThan(250);
    expect(after).not.toBe(before);
    expect(after[target]).not.toBe(before[target]);
    for (const seed of seeds.slice(0, -1)) {
      expect(after[seed.path]).toBe(before[seed.path]);
    }
  });
});
