// telemetry-events-row.test.ts — the `events` rows the platform hook builds (core/os
// platform-hook.ts `eventsRow`) fit the events stream's schema (apps/telemetry/schemas/events.json):
// a stream accepts a row that does not match and drops it, silently (docs/telemetry.md "Failures").
import type { StreamEvent } from "iterate/stream/processor";
import { expect, test } from "vitest";
import eventsSchema from "../../../apps/telemetry/schemas/events.json" with { type: "json" };
import { rowProblems } from "../../../apps/telemetry/src/stream-schema.test-support.ts";
import { eventsRow } from "../../../core/os/src/platform-hook.ts";

const event: StreamEvent = {
  type: "chat/message-added",
  offset: 42,
  createdAt: "2026-09-30T12:00:00.000Z",
  path: "/agents/web/1",
  payload: { text: "hello" },
  source: { origin: "/agents/web/1" },
};

test.for([
  {
    name: "a person's event, written in a cause",
    event: {
      ...event,
      source: {
        origin: "/agents/web/1",
        principal: { actor: "usr_1", email: "person@example.com" },
        cause: { chain: "2026-09-30T12:00:00.000Z with a call ~a1", depth: 1, parent: "/@41" },
      },
    },
  },
  {
    name: "the platform's own event: no actor, no cause, no payload",
    event: { ...event, payload: undefined },
  },
  { name: "a payload cut at 512 KB", event: { ...event, payload: { text: "é".repeat(300_000) } } },
])("the events stream's schema accepts the row of $name", ({ event }) => {
  expect(
    rowProblems(
      eventsSchema,
      eventsRow(event, { worker: "pr3142-a1b2c3d-os", projectId: "prj_1" }),
    ),
  ).toEqual([]);
});
