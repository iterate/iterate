// Regression tests for the stream-domain bugs fixed in the thermonuclear review.
//
// Each test is written to FAIL against the pre-fix code and pass afterwards, so
// the fix is pinned by observable behaviour rather than by inspection.

import { expect, test } from "vitest";
import { adminSecret, withItxSession } from "./test-helpers.ts";

const RUN_SUFFIX = crypto.randomUUID().slice(0, 8);
const STREAM_EVENT_TYPE = "events.iterate.test/minimal-v4/security-e2e";

// B2: the processor capability handed over RPC must expose only the read-only
// StreamProcessorRpc surface. Before the fix the DO returned the live
// StreamProcessor instance, so `ingest` (host-only plumbing) was remotely
// callable — a caller could fast-forward the checkpoint past every real event
// and permanently silence the processor.
test("project.processor does not expose the host-only ingest method over RPC", async () => {
  const marker = crypto.randomUUID();
  using session = withItxSession();
  using itx = session.authenticate({
    type: "admin-secret",
    secret: adminSecret(),
  });
  using project = itx.projects.create({ slug: `sec-ingest-${RUN_SUFFIX}-${marker}` });

  // Reach past the typed surface exactly as a hostile caller would.
  const processor = project.processor as unknown as {
    ingest?: (args: { events: unknown[]; streamMaxOffset: number }) => Promise<void>;
  };

  await expect(
    Promise.resolve().then(() =>
      processor.ingest!({
        events: [
          {
            type: STREAM_EVENT_TYPE,
            payload: { marker },
            offset: 9_999_999,
            createdAt: new Date().toISOString(),
          },
        ],
        streamMaxOffset: 9_999_999,
      }),
    ),
  ).rejects.toThrow();
});

// B3: append accepts an optional `offset` as an optimistic-concurrency
// assertion. Before the fix, core policy events (subscription-configured,
// rule-configured) ran the whole input — including that offset — through a
// strict Zod parse with no offset key, so the assertion form always threw
// "Unrecognized key: offset" instead of asserting.
test("append accepts an offset assertion on a rule-configured core event", async () => {
  const marker = crypto.randomUUID();
  const streamPath = `/e2e/security/offset-assert/${marker}`;

  using session = withItxSession();
  using itx = session.authenticate({
    type: "admin-secret",
    secret: adminSecret(),
  });
  using project = itx.projects.create({ slug: `sec-offset-${RUN_SUFFIX}-${marker}` });
  using stream = project.streams.get(streamPath);

  // A brand-new stream has committed created(1) + woken(2); the next append is 3.
  // `offset` is the DO's optimistic-concurrency assertion. It rides on the append
  // input at runtime but is intentionally absent from the narrow public `Stream`
  // type, so it is cast in here exactly as a concurrency-sensitive caller would.
  const appendWithOffset = stream.append as unknown as (
    event: Record<string, unknown>,
  ) => Promise<{ offset: number }[]>;
  const [configured] = await appendWithOffset({
    type: "events.iterate.com/stream/rule-configured",
    offset: 3,
    payload: {
      eventTypes: [STREAM_EVENT_TYPE],
      path: `/e2e/security/offset-assert-target/${marker}`,
      ruleId: `rule-${marker}`,
      type: "cross-post",
    },
  });

  expect(configured!.offset).toBe(3);
});

// B6: the subscriber descriptor supplied to subscribe() must be validated at the
// boundary. Before the fix it was cast unchecked, so a malformed descriptor blew
// up inside the reducer while appending the subscriber-connected fact — the
// append was swallowed, leaving a live connection with NO presence-roster entry
// (the runtime map and the event-sourced roster silently disagree).
test("subscribe rejects a malformed subscriber descriptor instead of corrupting the roster", async () => {
  const marker = crypto.randomUUID();
  const streamPath = `/e2e/security/bad-subscriber/${marker}`;

  using session = withItxSession();
  using itx = session.authenticate({
    type: "admin-secret",
    secret: adminSecret(),
  });
  using project = itx.projects.create({ slug: `sec-subscriber-${RUN_SUFFIX}-${marker}` });
  using stream = project.streams.get(streamPath);

  await expect(
    stream.subscribe({
      // incarnationId must be a non-empty string; the reducer's schema would
      // reject this, but only after the connection is already live.
      subscriber: { incarnationId: "" } as unknown,
      processEventBatch: () => {},
    }),
  ).rejects.toThrow();

  // The roster must not contain a half-open connection from the rejected attempt.
  const runtimeState = (await stream.runtimeState()) as {
    coreProcessorState: { connectionsByKey?: Record<string, unknown> };
    runtime: { connections: Record<string, unknown> };
  };
  const runtimeKeys = Object.keys(runtimeState.runtime.connections);
  const rosterKeys = Object.keys(runtimeState.coreProcessorState.connectionsByKey ?? {});
  expect(runtimeKeys).toEqual(rosterKeys);
});
