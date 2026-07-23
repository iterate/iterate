// Regression tests for the stream-domain bugs fixed in the thermonuclear review.
//
// Each test is written to FAIL against the pre-fix code and pass afterwards, so
// the fix is pinned by observable behaviour rather than by inspection.

import { expect, test } from "vitest";
import { adminSecret, withItxSession } from "./test-helpers.ts";

const RUN_SUFFIX = crypto.randomUUID().slice(0, 8);
const STREAM_EVENT_TYPE = "events.iterate.test/minimal-v4/security-e2e";

test("project users cannot reach stream test controls or the raw Durable Object", async () => {
  const marker = crypto.randomUUID();
  const projectSlug = `sec-stream-internals-${RUN_SUFFIX}-${marker}`;
  const streamPath = `/e2e/security/stream-internals/${marker}`;
  const idempotencyKey = `security-marker:${marker}`;

  using adminSession = withItxSession();
  using admin = adminSession.authenticate({ type: "admin-secret", secret: adminSecret() });
  using adminProject = await admin.projects.get(projectSlug).create({});
  const { projectId } = await adminProject.__describe();
  using adminStream = adminProject.streams.get(streamPath);
  const [durableMarker] = await adminStream.append({
    type: STREAM_EVENT_TYPE,
    idempotencyKey,
    payload: { marker },
  });

  using userSession = withItxSession();
  using user = userSession.authenticate({
    type: "impersonate",
    secret: adminSecret(),
    token: {
      type: "user",
      principal: `stream-security-${marker}`,
      projectScopes: [projectId],
    },
  });
  using userProject = user.projects.get(projectId);
  using userStream = userProject.streams.get(streamPath);
  const hostile = userStream as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;

  const attempts: Array<[string, unknown[]]> = [
    ["testRunIdleTeardownNow", []],
    ["testReset", []],
    [
      "testAppendCoreEvents",
      [[{ type: "events.iterate.com/stream/cross-post-list-resend-requested", payload: {} }]],
    ],
    ["testReceiveStreamEvents", [{}]],
  ];
  for (const [method, args] of attempts) {
    await expect(async () => {
      await hostile[method]!(...args);
    }).rejects.toThrow(/available only to admins outside production/);
  }

  // This used to expose every native Stream Durable Object method through a
  // string-keyed property on the public target. The raw handle is now keyed by
  // a server-only Symbol, which Cap'n Web cannot address by member path.
  await expect(async () => {
    const legacyRawHandle = userStream as unknown as {
      durableObjectStub: { reset(): Promise<void> };
    };
    await legacyRawHandle.durableObjectStub.reset();
  }).rejects.toThrow();

  expect(await userStream.getEvent({ idempotencyKey })).toMatchObject({
    offset: durableMarker!.offset,
    payload: { marker },
  });
});

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
  using project = await itx.projects.get(`sec-ingest-${RUN_SUFFIX}-${marker}`).create({});

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
// assertion. Before the fix, core policy events ran
// the whole input — including that offset — through a strict Zod parse with no
// offset key, so the assertion form always threw "Unrecognized key: offset"
// instead of asserting.
test("append accepts an offset assertion on a subscription configuration event", async () => {
  const marker = crypto.randomUUID();
  const streamPath = `/e2e/security/offset-assert/${marker}`;

  using session = withItxSession();
  using itx = session.authenticate({
    type: "admin-secret",
    secret: adminSecret(),
  });
  using project = await itx.projects.get(`sec-offset-${RUN_SUFFIX}-${marker}`).create({});
  using stream = project.streams.get(streamPath);

  // A brand-new project stream has committed created(1) + the birth-certificate
  // project-worker subscription(2) + the PostHog subscription(3) +
  // woken(4); the next append is 5. `offset` is the DO's optimistic-concurrency
  // assertion. It rides on the append input at runtime but is intentionally
  // absent from the narrow public `Stream` type, so it is cast in here exactly
  // as a concurrency-sensitive caller would.
  const appendWithOffset = stream.append as unknown as (
    event: Record<string, unknown>,
  ) => Promise<{ offset: number }[]>;
  const [configured] = await appendWithOffset({
    type: "events.iterate.com/stream/subscription-configured",
    offset: 5,
    payload: {
      subscriptionKey: `stream-${marker}`,
      receiver: {
        action: "cross-post",
        receivingStreamPath: `/e2e/security/offset-assert-target/${marker}`,
        delivery: {
          start: "now",
          includeEphemeral: false,
          onFailingEvent: "halt",
        },
      },
      filter: { eventTypes: [STREAM_EVENT_TYPE] },
    },
  });

  expect(configured!).toMatchObject({ offset: 5 });
});

// B6: openedBy supplied to openConnection() must be validated at the RPC
// boundary. Before the fix it was cast unchecked, so malformed data failed only
// after the callback had been installed. The rejected call must leave no
// runtime connection behind.
test("openConnection rejects a malformed callback owner before installing the callback", async () => {
  const marker = crypto.randomUUID();
  const streamPath = `/e2e/security/bad-callback-owner/${marker}`;

  using session = withItxSession();
  using itx = session.authenticate({
    type: "admin-secret",
    secret: adminSecret(),
  });
  using project = await itx.projects.get(`sec-subscriber-${RUN_SUFFIX}-${marker}`).create({});
  using stream = project.streams.get(streamPath);

  // An explicit key makes the rejected attempt identifiable in the state
  // snapshot below — unrelated callbacks (e.g. the project's browser mirror)
  // can open on their own schedule, so whole-map comparisons race them.
  const rejectedKey = `bad-callback-owner-${marker}`;
  // The async-closure form makes the await real: expect(stub).rejects on a
  // capnweb pipeline stub can pass vacuously, which is how this test's old
  // probe (an unknown `incarnationId` key the schema merely STRIPS) sat green
  // while asserting nothing.
  await expect(async () => {
    await stream.openConnection({
      connectionKey: rejectedKey,
      // description must be a string; the boundary parse rejects this before
      // any connection opens.
      openedBy: { description: 123 } as unknown,
      processEventBatch: () => {},
    });
  }).rejects.toThrow();

  const state = (await stream.runtimeState()) as {
    runtime: { connections: Record<string, unknown> };
  };
  // Nothing half-open from the rejected attempt.
  expect(state.runtime.connections[rejectedKey]).toBeUndefined();
});
