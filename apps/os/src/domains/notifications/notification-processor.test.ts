// The notification processor's executable spec, on the generic step harness
// from iterate/processors/testing: the REAL StreamProcessorRunner over the
// shared MemoryStream (production idempotency semantics: a same-key append
// with a different body is REJECTED). The processor takes no domain fakes —
// every intent derives from the triggering event alone.

import { describe, expect, it } from "vitest";
import type { ConsumedInput } from "iterate/processors";
import {
  makeMemoryProgressStore,
  makeProcessorHarness,
  type HarnessSubstrate,
} from "iterate/processors/testing";
import type { NotificationProcessorContract } from "./notification-processor-contract.ts";
import { NotificationProcessor } from "./notification-processor-implementation.ts";

type NotificationEventInput = ConsumedInput<NotificationProcessorContract>;

const NOTIFICATION_CREATED = {
  type: "events.iterate.com/notification/created",
  payload: { config: {} },
} satisfies NotificationEventInput;

const STRIPE_APPROVAL = {
  type: "events.iterate.com/project/human-approval-requested",
  payload: {
    method: "POST",
    url: "https://api.stripe.com/v1/transfers",
    headers: {},
    bodySha256: null,
    bodyPreview: null,
    secretPaths: ["/secrets/stripe/prod"],
    ruleKey: "stripe-mutations",
    expiresAt: "2026-07-19T08:05:00.000Z",
  },
} satisfies NotificationEventInput;

/** The generic harness on the project ROOT stream — where this processor is
 * registered in production, and what the idempotency keys embed. */
function makeNotificationHarness(substrate?: HarnessSubstrate) {
  return makeProcessorHarness<NotificationProcessorContract>({
    createProcessor: (deps) => new NotificationProcessor(deps),
    path: "/",
    ...(substrate === undefined ? {} : { substrate }),
  });
}

describe("NotificationProcessor approval intents", () => {
  it("one held approval becomes one project notification intent, keyed on the approval event", async () => {
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
        audience: { kind: "project" },
        title: "Approval needed",
        body: "POST api.stripe.com is waiting for approval.",
        destination: { kind: "approvals", approvalRequestEventOffset: 2 },
        expiresAt: Date.parse("2026-07-19T08:05:00.000Z"),
      },
    });
    expect(h.state().birthCertificate).toEqual({ config: {} });
  });

  it("an approval recorded before notification setup is delivered during replay", async () => {
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
          method: "POST",
          url: "buy milk near the supermarket",
          headers: {},
          bodySha256: null,
          bodyPreview: null,
          secretPaths: [],
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
    // re-runs. The intent body is deterministic from the approval event
    // (expiresAt copies the approval's horizon, never `now`), so the
    // re-append dedupes instead of raising a same-key conflict.
    const h = makeNotificationHarness();
    await h.play(["append", NOTIFICATION_CREATED, STRIPE_APPROVAL], ["advanceTime", 60_000]);
    const committedOffsets = h.events().map((event) => event.offset);

    const replay = makeNotificationHarness({
      clock: h.clock,
      stream: h.stream,
      progress: makeMemoryProgressStore(),
    });
    await replay.settle(); // replays the whole stream; a wedge would throw here

    expect(replay.events().map((event) => event.offset)).toEqual(committedOffsets);
    expect(replay.events("events.iterate.com/notification/requested")).toHaveLength(1);
    expect(replay.state().birthCertificate).toEqual({ config: {} });
  });
});
