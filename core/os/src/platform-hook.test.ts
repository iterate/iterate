// platform-hook.test.ts — the `events` row the platform hook builds from one durable event, and the
// outbox that sends a context's rows, over a stream whose sends each row settles by hand
// (docs/telemetry.md#events). That the events stream's schema accepts such rows is
// test/vitest/os/telemetry-events-row.test.ts; a real send is Cloudflare's binding, which no test
// here binds.
import type { StreamEvent } from "iterate/stream/processor";
import { expect, test, vi } from "vitest";
import { eventsOutbox, eventsRow } from "./platform-hook.ts";

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
    name: "a payload of 0 is stored as itself, not as {}",
    event: committed({ payload: 0 }),
    row: { payload: "0", payload_bytes: 1 },
  },
  {
    name: 'a payload of "" is stored as itself, not as {}',
    event: committed({ payload: "" }),
    row: { payload: '""', payload_bytes: 2 },
  },
  {
    name: "a payload of false is stored as itself, not as {}",
    event: committed({ payload: false }),
    row: { payload: "false", payload_bytes: 5 },
  },
  {
    name: "a payload over 512 KB is halved, and payload_bytes stays its whole size",
    // 9 bytes of `{"text":"`, then two per é: the cut halves one, which decodes as U+FFFD
    event: committed({ payload: { text: "é".repeat(300_001) } }),
    row: {
      payload: `{"text":"${"é".repeat(149_998)}�`,
      payload_bytes: 600_013,
    },
  },
  {
    name: "a payload under 512 KB that the row's JSON escapes to over it is halved too",
    // 200,000 backslashes are 400,000 bytes of payload, and 800,000 of the row's JSON
    event: committed({ payload: { text: "\\".repeat(200_000) } }),
    row: {
      payload: `{"text":"${"\\".repeat(199_996)}`,
      payload_bytes: 400_011,
    },
  },
];

test.for(rows)("$name", ({ event, row }) => {
  expect(eventsRow(event, source)).toMatchObject(row);
});

// ── the outbox: one send out at a time, with everything that waited for it ──

const storageReset = new Error(
  "Internal error in Durable Object storage caused object to be reset; reference = 2f8q",
);

test.for([
  {
    name: "the first event after a quiet spell is sent at once, alone",
    steps: [{ events: [1] }],
    sent: [[1]],
    logged: [],
  },
  {
    name: "events that arrive while a send is out go together in the next, once it settles",
    steps: [{ events: [1] }, { events: [2, 3] }, { events: [4] }, { succeeds: true }],
    sent: [[1], [2, 3, 4]],
    logged: [],
  },
  {
    name: "a send carries at most 4 MB: twelve waiting rows of 500 KB go as eight, then four",
    steps: [
      { events: [1] },
      { events: [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13], kb: 500 },
      { succeeds: true },
      { succeeds: true },
    ],
    sent: [[1], [2, 3, 4, 5, 6, 7, 8, 9], [10, 11, 12, 13]],
    logged: [],
  },
  {
    name: "at most 8 MB waits: sixteen rows of 500 KB, and the next send logs the three dropped",
    steps: [
      { events: [1] },
      { events: [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20], kb: 500 },
      { succeeds: true },
      { succeeds: true },
      { succeeds: true },
    ],
    sent: [[1], [2, 3, 4, 5, 6, 7, 8, 9], [10, 11, 12, 13, 14, 15, 16, 17]],
    logged: [{ level: "warn", event: "telemetry.events-dropped", projectId: "prj_1", count: 3 }],
  },
  {
    name: "a send a storage reset failed is the platform's failure, a warn, and the next goes",
    steps: [{ events: [1] }, { events: [2, 3] }, { fails: storageReset }, { fails: storageReset }],
    sent: [[1], [2, 3]],
    logged: [
      {
        level: "warn",
        event: "telemetry.platform-failure-send",
        kind: "disconnected",
        projectId: "prj_1",
        path: "/agents/web/1",
        rows: 1,
        message: `Error: ${storageReset.message}`,
      },
      { level: "warn", event: "telemetry.platform-failure-send", kind: "disconnected", rows: 2 },
    ],
  },
  {
    name: "a send a deploy's reset failed is expected, an info",
    steps: [
      { events: [1] },
      { fails: new Error("Durable Object reset because its code was updated.") },
    ],
    sent: [[1]],
    logged: [
      { level: "info", event: "telemetry.deploy-reset-send", kind: "deploy-reset", rows: 1 },
    ],
  },
  {
    name: "a send that failed any other way is an issue, and the next goes",
    steps: [{ events: [1] }, { events: [2] }, { fails: new Error("no such stream") }],
    sent: [[1], [2]],
    logged: [{ level: "error", event: "issue", failureSite: "telemetry.send", rows: 1 }],
  },
  {
    name: "a send that throws instead of answering is an issue too: nothing throws, the next goes",
    steps: [{ throws: new Error("the binding is gone") }, { events: [1] }, { events: [2] }],
    sent: [[1], [2]],
    logged: [
      { level: "error", event: "issue", failureSite: "telemetry.send", rows: 1 },
      { level: "error", event: "issue", failureSite: "telemetry.send", rows: 1 },
    ],
  },
])("the outbox: $name", async ({ steps, sent, logged }) => {
  const rig = outboxRig();
  await rig.run(steps);
  expect({ sent: rig.sent, logged: rig.logged }).toMatchObject({ sent, logged });
});

/** A committed event: a message someone's code appended at offset 42, and no one's. Its payload may
 *  be any JSON value, as one off the wire may be whatever its type says: the one cast. */
function committed(overrides: Partial<Omit<StreamEvent, "payload">> & { payload?: unknown }) {
  return {
    type: "chat/message-added",
    offset: 42,
    createdAt: "2026-09-30T12:00:00.000Z",
    path: "/agents/web/1",
    payload: { text: "hello" },
    source: { origin: "/agents/web/1" },
    ...overrides,
  } as StreamEvent;
}

/** An outbox over a stream that answers no send until a step does. `run` takes a row's steps in
 *  turn, letting what each sets off land: `events` commits one event per offset, each with `kb` KB
 *  of payload; `succeeds` resolves the send that is out and `fails` rejects it with the error;
 *  after `throws`, `send` throws that instead of returning a promise. `sent` is every send's rows,
 *  by offset, and `logged` every console line, with its level. */
function outboxRig() {
  const sent: unknown[][] = [];
  const logged: Record<string, unknown>[] = [];
  const out: { resolve: () => void; reject: (error: Error) => void }[] = [];
  let thrown: Error | undefined;
  for (const level of ["info", "warn", "error"] as const)
    vi.spyOn(console, level).mockImplementation(
      (line: object) => void logged.push({ level, ...line }),
    );
  const outbox = eventsOutbox({
    ...source,
    eventsStream: {
      send(rows) {
        sent.push(rows.map((row) => row.offset));
        if (thrown) throw thrown;
        return new Promise<void>((resolve, reject) => out.push({ resolve, reject }));
      },
    },
  });
  return {
    sent,
    logged,
    async run(
      steps: {
        events?: number[];
        kb?: number;
        succeeds?: boolean;
        fails?: Error;
        throws?: Error;
      }[],
    ) {
      for (const { events = [], kb = 0, succeeds, fails, throws } of steps) {
        thrown = throws || thrown;
        for (const offset of events)
          outbox(committed({ offset, payload: { text: "a".repeat(kb * 1000) } }));
        if (succeeds) out.shift()?.resolve();
        if (fails) out.shift()?.reject(fails);
        await new Promise((resolve) => setTimeout(resolve));
      }
    },
  };
}
