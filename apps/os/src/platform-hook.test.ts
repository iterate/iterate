// platform-hook.test.ts — the `events` row the platform hook builds from one durable event
// (docs/telemetry.md#events), and that the events stream's schema accepts it: a stream drops a
// row that does not match, silently. Sending it is Cloudflare's binding, which no test here binds.
import type { StreamEvent } from "iterate/stream/processor";
import { expect, test } from "vitest";
import eventsSchema from "../../telemetry/schemas/events.json" with { type: "json" };
import { eventsRow } from "./platform-hook.ts";

const source = { worker: "pr3142-a1b2c3d-os", projectId: "prj_1" };

const rows = [
  {
    name: "a person's event: their actor id, never their email, and the cause it was written in",
    event: committed({
      source: {
        origin: "/agents/web/1",
        principal: { actor: "usr_1", email: "person@example.com" },
        cause: { chain: "2026-09-30T12:00:00.000Z with a call ~a1", depth: 1, parent: "/@41" },
      },
    }),
    row: {
      time: "2026-09-30T12:00:00.000Z",
      worker: "pr3142-a1b2c3d-os",
      project_id: "prj_1",
      path: "/agents/web/1",
      offset: 42,
      type: "chat/message-added",
      actor: "usr_1",
      cause_chain: "2026-09-30T12:00:00.000Z with a call ~a1",
      cause_depth: 1,
      cause_parent: "/@41",
      payload: '{"text":"hello"}',
      payload_bytes: 16,
    },
  },
  {
    name: "the platform's own event with no payload: no actor, no cause, and {} as its payload",
    event: committed({ payload: undefined }),
    row: {
      time: "2026-09-30T12:00:00.000Z",
      worker: "pr3142-a1b2c3d-os",
      project_id: "prj_1",
      path: "/agents/web/1",
      offset: 42,
      type: "chat/message-added",
      actor: null,
      cause_chain: null,
      cause_depth: null,
      cause_parent: null,
      payload: "{}",
      payload_bytes: 2,
    },
  },
  {
    name: "a payload over 512 KB is cut there, and payload_bytes stays its whole size",
    // 9 bytes of `{"text":"`, then two per é: the cut halves one, which decodes as U+FFFD
    event: committed({ payload: { text: "é".repeat(300_000) } }),
    row: {
      payload: `{"text":"${"é".repeat(262_139)}�`,
      payload_bytes: 600_011,
    },
  },
];

test.for(rows)("$name", ({ event, row }) => {
  expect(eventsRow(event, source)).toMatchObject(row);
});

test.for(rows)("the events stream's schema accepts the row of $name", ({ event }) => {
  expect(schemaMismatches(eventsRow(event, source))).toEqual([]);
});

/** A committed event: a message someone's code appended at offset 42, and no one's. */
function committed(overrides: Partial<StreamEvent>): StreamEvent {
  return {
    type: "chat/message-added",
    offset: 42,
    createdAt: "2026-09-30T12:00:00.000Z",
    path: "/agents/web/1",
    payload: { text: "hello" },
    source: { origin: "/agents/web/1" },
    ...overrides,
  };
}

/** How a row differs from what the stream's schema (Pipelines' field types) accepts: a key it has
 *  no column for, a required column null, a value not of its column's type. */
function schemaMismatches(row: Record<string, unknown>): string[] {
  const columns = new Set(eventsSchema.fields.map((field) => field.name));
  return [
    ...Object.keys(row)
      .filter((key) => !columns.has(key))
      .map((key) => `${key}: no such column`),
    ...eventsSchema.fields.flatMap(({ name, type, required }) => {
      // a column the row leaves out is undefined: of no column's type
      const value = row[name];
      if (value === null) return required ? [`${name}: null`] : [];
      return isOfType[type]?.(value) ? [] : [`${name}: not ${type}`];
    }),
  ];
}

const isOfType: Record<string, (value: unknown) => boolean> = {
  string: (value) => typeof value === "string",
  int32: (value) => Number.isInteger(value) && Math.abs(Number(value)) < 2 ** 31,
  int64: (value) => Number.isSafeInteger(value),
  timestamp: (value) => typeof value === "string" && !Number.isNaN(Date.parse(value)),
};
