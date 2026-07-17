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
// assertion. Before the fix, core policy events (subscription-configured) ran
// the whole input — including that offset — through a strict Zod parse with no
// offset key, so the assertion form always threw "Unrecognized key: offset"
// instead of asserting.
test("append accepts an offset assertion on a subscription-configured core event", async () => {
  const marker = crypto.randomUUID();
  const streamPath = `/e2e/security/offset-assert/${marker}`;

  using session = withItxSession();
  using itx = session.authenticate({
    type: "admin-secret",
    secret: adminSecret(),
  });
  using project = itx.projects.create({ slug: `sec-offset-${RUN_SUFFIX}-${marker}` });
  using stream = project.streams.get(streamPath);

  // A brand-new project stream has committed created(1) + the birth-certificate
  // project-worker feed's subscription-configured(2) + woken(3); the next append
  // is 4. `offset` is the DO's optimistic-concurrency assertion. It rides on the
  // append input at runtime but is intentionally absent from the narrow public
  // `Stream` type, so it is cast in here exactly as a concurrency-sensitive
  // caller would.
  const appendWithOffset = stream.append as unknown as (
    event: Record<string, unknown>,
  ) => Promise<{ offset: number }[]>;
  const [configured] = await appendWithOffset({
    type: "events.iterate.com/stream/subscription-configured",
    offset: 4,
    payload: {
      subscriptionKey: `cross-post-${marker}`,
      delivery: {
        mode: "push",
        expression: [
          "streams",
          ["get", `/e2e/security/offset-assert-target/${marker}`],
          "acceptCrossPost",
        ],
      },
      selector: { eventTypes: [STREAM_EVENT_TYPE] },
    },
  });

  expect(configured!).toMatchObject({ offset: 4 });
});

// B6: the subscriber descriptor supplied to subscribe() must be validated at the
// boundary. Before the fix it was cast unchecked, so a malformed descriptor blew
// up inside the reducer while appending the subscriber-connected fact — the
// append was swallowed, leaving a live connection nothing could account for.
// Ephemeral connections no longer fold into the reduced roster at all (core
// state v14; the runtime connection table is their only home), so the
// invariants here are: a rejected subscribe leaves NO runtime connection
// behind, and the reduced roster never carries ephemeral entries.
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

  // An explicit key makes the rejected attempt identifiable in the state
  // snapshot below — ambient connections (e.g. the project's stream mirror)
  // dial in on their own schedule, so whole-map comparisons race them.
  const rejectedKey = `bad-subscriber-${marker}`;
  // The async-closure form makes the await real: expect(stub).rejects on a
  // capnweb pipeline stub can pass vacuously, which is how this test's old
  // probe (an unknown `incarnationId` key the schema merely STRIPS) sat green
  // while asserting nothing.
  await expect(async () => {
    await stream.subscribe({
      subscriptionKey: rejectedKey,
      // description must be a string; the boundary parse rejects this before
      // any connection opens.
      subscriber: { description: 123 } as unknown,
      processEventBatch: () => {},
    });
  }).rejects.toThrow();

  const state = (await stream.runtimeState()) as {
    coreProcessorState: {
      connectionsByKey?: Record<string, { subscriptionType?: string }>;
    };
    runtime: { connections: Record<string, unknown> };
  };
  // Nothing half-open from the rejected attempt, in either table.
  expect(state.runtime.connections[rejectedKey]).toBeUndefined();
  expect(state.coreProcessorState.connectionsByKey?.[rejectedKey]).toBeUndefined();
  // The reduced roster tracks configured subscriptions only (core state v14).
  for (const [key, connection] of Object.entries(state.coreProcessorState.connectionsByKey ?? {})) {
    expect(connection, `roster entry ${key}`).toMatchObject({ subscriptionType: "configured" });
  }
});
