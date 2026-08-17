// The notification processor's executable spec, on the generic step harness
// from iterate/processors/testing: the REAL StreamProcessorRunner over the
// shared MemoryStream (production idempotency semantics: a same-key append
// with a different body is REJECTED). The processor is stateless per event —
// every intent derives from the triggering approval batch event alone; the
// egress door already coalesced any burst into ONE event (ADR 0007).

import { describe, expect, it } from "vitest";
import type { ConsumedInput } from "iterate/processors";
import {
  makeMemoryProgressStore,
  makeProcessorHarness,
  MemoryStream,
  type HarnessSubstrate,
} from "iterate/processors/testing";
import { NotificationProcessorContract } from "./notification-processor-contract.ts";
import { NotificationProcessor } from "./notification-processor-implementation.ts";

type NotificationEventInput = ConsumedInput<NotificationProcessorContract>;

const T0 = Date.parse("2026-07-19T08:00:00Z");
const INTENT = "events.iterate.com/notification/requested";

const NOTIFICATION_CREATED = {
  type: "events.iterate.com/notification/created",
  payload: { config: {} },
} satisfies NotificationEventInput;

const STRIPE_APPROVAL = {
  type: "events.iterate.com/project/human-approval-requested",
  payload: {
    requests: [
      {
        method: "POST",
        url: "https://api.stripe.com/v1/transfers",
        headers: {},
        body: null,
        secretPaths: ["/secrets/stripe/prod"],
      },
    ],
    ruleKey: "stripe-mutations",
    expiresAt: "2026-07-19T08:05:00.000Z",
  },
} satisfies NotificationEventInput;

describe("NotificationProcessor approval intents", () => {
  it("one held batch of one becomes one project notification intent, keyed on the batch event", async () => {
    const h = makeNotificationHarness();
    await h.play(["append", NOTIFICATION_CREATED, STRIPE_APPROVAL]);

    expect(h.events().map((event) => event.type)).toEqual([
      "events.iterate.com/notification/created",
      "events.iterate.com/project/human-approval-requested",
      "events.iterate.com/notification/requested",
    ]);
    expect(h.events().at(-1)).toMatchObject({
      type: "events.iterate.com/notification/requested",
      idempotencyKey: "notification/approval-requested@/:2",
      payload: {
        // Top-level batch identity: the suppression handle every destination
        // kind carries (approval-presented claims match against it).
        approvalRequestEventOffset: 2,
        audience: { kind: "project" },
        title: "Approval needed",
        body: "POST api.stripe.com is waiting for approval.",
        destination: { kind: "approvals", approvalRequestEventOffset: 2 },
        expiresAt: Date.parse("2026-07-19T08:05:00.000Z"),
      },
    });
    expect(h.state().birthCertificate).toEqual({ config: {} });
  });

  it("a script run's burst batch becomes ONE summary push, hosts busiest-first", async () => {
    const h = makeNotificationHarness();
    await h.play([
      "append",
      NOTIFICATION_CREATED,
      {
        type: "events.iterate.com/project/human-approval-requested",
        payload: {
          requests: [
            gmailSend(),
            gmailSend(),
            {
              method: "POST",
              url: "https://api.stripe.com/v1/transfers",
              headers: {},
              body: null,
              secretPaths: [],
            },
          ],
          ruleKey: "gmail-sends",
          ruleDescription: "Gmail sends need a human",
          expiresAt: "2026-07-19T08:05:00.000Z",
          streamContext: {
            kind: "script-execution",
            streamPath: "/agents/demo",
            scriptRunRequestedEventOffset: 1,
            executionId: "exec-1",
          },
        },
      },
    ]);

    expect(h.events(INTENT)).toHaveLength(1);
    expect(h.events(INTENT)[0]).toMatchObject({
      idempotencyKey: "notification/approval-requested@/:2",
      payload: {
        // The agent-chat destination has no batch identity of its own, so the
        // top-level suppression handle matters most HERE.
        approvalRequestEventOffset: 2,
        audience: { kind: "project" },
        title: "Approvals needed",
        body: "Script run waiting: 3 requests (2x gmail.googleapis.com, 1x api.stripe.com)",
        // An agent thread's batch deep-links to the THREAD — the in-thread
        // dialog is the approval surface; the approvals screen is history.
        destination: { kind: "agent-chat", path: "/agents/demo" },
        expiresAt: Date.parse("2026-07-19T08:05:00.000Z"),
      },
    });
  });

  it("a batch recorded before notification setup is delivered during replay", async () => {
    const h = makeNotificationHarness();
    await h.play(["append", STRIPE_APPROVAL, NOTIFICATION_CREATED]);

    expect(h.events().at(-1)).toMatchObject({
      type: "events.iterate.com/notification/requested",
      idempotencyKey: "notification/approval-requested@/:1",
      payload: {
        destination: { kind: "approvals", approvalRequestEventOffset: 1 },
      },
    });
  });

  it("an unparseable approval URL remains visible without stalling notification delivery", async () => {
    const h = makeNotificationHarness();
    await h.play([
      "append",
      NOTIFICATION_CREATED,
      {
        type: "events.iterate.com/project/human-approval-requested",
        payload: {
          requests: [
            {
              method: "POST",
              url: "buy milk near the supermarket",
              headers: {},
              body: null,
              secretPaths: [],
            },
          ],
          ruleKey: "custom-action",
          expiresAt: "2026-07-19T08:05:00.000Z",
        },
      },
    ]);

    expect(h.events().at(-1)).toMatchObject({
      type: "events.iterate.com/notification/requested",
      payload: {
        body: "POST buy milk near the supermarket is waiting for approval.",
        destination: { kind: "approvals", approvalRequestEventOffset: 2 },
      },
    });
  });

  it("a duplicate birth certificate reduces to a no-op instead of wedging the frame", async () => {
    const h = makeNotificationHarness();
    await h.play(["append", NOTIFICATION_CREATED, NOTIFICATION_CREATED, STRIPE_APPROVAL]);

    expect(h.state().birthCertificate).toEqual({ config: {} });
    expect(h.events("events.iterate.com/notification/requested")).toHaveLength(1);
  });

  it("a full replay (fresh cursor over the same stream) re-appends identical intents that dedupe on the key", async () => {
    // The harshest at-least-once redelivery: a fresh progress store over the
    // SAME stream replays every event, so the per-event blocked append
    // re-runs. The intent body is deterministic from the batch event
    // (expiresAt copies the batch's horizon, never `now`), so the re-append
    // dedupes instead of raising a same-key conflict.
    const h = makeNotificationHarness();
    await h.play(["append", NOTIFICATION_CREATED, STRIPE_APPROVAL], ["advanceTime", 60_000]);
    const committedOffsets = h.events().map((event) => event.offset);

    const replay = makeNotificationHarness({
      clock: h.clock,
      stream: h.stream,
      progress: makeMemoryProgressStore(NotificationProcessorContract),
    });
    await replay.settle(); // replays the whole stream; a wedge would throw here

    expect(replay.events().map((event) => event.offset)).toEqual(committedOffsets);
    expect(replay.events("events.iterate.com/notification/requested")).toHaveLength(1);
    expect(replay.state().birthCertificate).toEqual({ config: {} });
  });
});

// -----------------------------------------------------------------------------
// Fixtures.
// -----------------------------------------------------------------------------

/** The generic harness on the project ROOT stream — where this processor is
 * registered in production, and what the idempotency keys embed. */
function makeNotificationHarness(substrateOverride?: HarnessSubstrate) {
  const substrate: HarnessSubstrate = substrateOverride || {
    clock: { now: T0 },
    stream: new MemoryStream("/"),
    progress: makeMemoryProgressStore(NotificationProcessorContract),
  };
  return makeProcessorHarness<NotificationProcessorContract, NotificationProcessor>({
    createProcessor: (deps) => new NotificationProcessor(deps),
    substrate,
  });
}

function gmailSend() {
  return {
    method: "POST",
    url: "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
    headers: {},
    body: null,
    secretPaths: [],
  };
}
