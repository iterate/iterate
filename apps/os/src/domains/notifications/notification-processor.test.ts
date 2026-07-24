// The notification processor's executable spec, on the generic step harness
// from iterate/processors/testing: the REAL StreamProcessorRunner over the
// shared MemoryStream (production idempotency semantics: a same-key append
// with a different body is REJECTED). Ungrouped intents derive from the
// triggering event alone; the Approval Group debounce (the processor's one
// documented state machine) is driven with the harness's virtual clock and
// direct fireDueApprovalGroupWindows() calls — exactly what the hosting DO's
// alarm() does, and never a real sleep.

import { describe, expect, it, vi } from "vitest";
import type { ConsumedInput } from "iterate/processors";
import {
  makeMemoryProgressStore,
  makeProcessorHarness,
  MemoryStream,
  type HarnessSubstrate,
} from "iterate/processors/testing";
import type { NotificationProcessorContract } from "./notification-processor-contract.ts";
import {
  APPROVAL_GROUP_DEBOUNCE_CAP_MS,
  APPROVAL_GROUP_DEBOUNCE_WINDOW_MS,
  NotificationProcessor,
} from "./notification-processor-implementation.ts";

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
    method: "POST",
    url: "https://api.stripe.com/v1/transfers",
    headers: {},
    body: null,
    secretPaths: ["/secrets/stripe/prod"],
    ruleKey: "stripe-mutations",
    expiresAt: "2026-07-19T08:05:00.000Z",
  },
} satisfies NotificationEventInput;

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
    // A scope-context hold never enters the Approval Group state machine.
    expect(h.state().approvalGroups).toEqual({});
    expect(h.repointAlarm).toHaveBeenLastCalledWith(null);
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
          body: null,
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

describe("Approval Group debounce", () => {
  it("a burst of script holds gets NO per-request intents and ONE summary push from the full open set", async () => {
    const h = makeNotificationHarness();
    await h.play([
      "append",
      NOTIFICATION_CREATED,
      scriptHold({ executionId: "exec-1" }),
      scriptHold({ executionId: "exec-1" }),
      scriptHold({ executionId: "exec-1", url: "https://api.stripe.com/v1/transfers" }),
    ]);

    // No push yet — the window is open and the alarm carries the obligation.
    expect(h.events(INTENT)).toHaveLength(0);
    expect(h.state().approvalGroups["exec-1"]).toMatchObject({
      window: { firstHeldOffset: 2, opensAtMs: T0, lastHeldAtMs: T0 },
      notifiedThroughOffset: 0,
    });
    expect(h.repointAlarm).toHaveBeenLastCalledWith(T0 + APPROVAL_GROUP_DEBOUNCE_WINDOW_MS);

    // Before the window is due, a wake fires nothing.
    await expect(h.processor().fireDueApprovalGroupWindows()).resolves.toEqual({ notified: 0 });

    await h.advanceTime(APPROVAL_GROUP_DEBOUNCE_WINDOW_MS);
    await expect(h.processor().fireDueApprovalGroupWindows()).resolves.toEqual({ notified: 1 });
    // A crashed wake re-running against un-advanced state observes the
    // committed push under the window's key and skips it.
    await expect(h.processor().fireDueApprovalGroupWindows()).resolves.toEqual({ notified: 0 });
    await h.settle();

    expect(h.events(INTENT)).toHaveLength(1);
    expect(h.events(INTENT)[0]).toMatchObject({
      idempotencyKey: "notification/approval-group@exec-1:2",
      payload: {
        audience: { kind: "project" },
        title: "Approvals needed",
        body: "Script run waiting: 3 requests (2x gmail.googleapis.com, 1x api.stripe.com)",
        destination: { kind: "approvals-group", executionId: "exec-1" },
        expiresAt: Date.parse("2026-07-19T08:05:00.000Z"),
      },
    });
    // The fired intent reduced back through the processor and closed its window.
    expect(h.state().approvalGroups["exec-1"]).toMatchObject({
      window: null,
      notifiedThroughOffset: 4,
    });
    expect(h.repointAlarm).toHaveBeenLastCalledWith(null);
  });

  it("each new hold extends the window and the cap bounds a drip-feeding script", async () => {
    const h = makeNotificationHarness();
    await h.play(["append", NOTIFICATION_CREATED, scriptHold({ executionId: "drip" })]);
    expect(h.repointAlarm).toHaveBeenLastCalledWith(T0 + APPROVAL_GROUP_DEBOUNCE_WINDOW_MS);

    // A hold at T0+2s pushes the fire time to T0+5s…
    await h.play(["advanceTime", 2_000], ["append", scriptHold({ executionId: "drip" })]);
    expect(h.repointAlarm).toHaveBeenLastCalledWith(T0 + 5_000);

    // …but dripping every 2s cannot postpone past the cap.
    for (const at of [4_000, 6_000, 8_000]) {
      await h.play(["advanceTime", 2_000], ["append", scriptHold({ executionId: "drip" })]);
      expect(h.repointAlarm).toHaveBeenLastCalledWith(
        Math.min(T0 + at + APPROVAL_GROUP_DEBOUNCE_WINDOW_MS, T0 + APPROVAL_GROUP_DEBOUNCE_CAP_MS),
      );
    }

    await h.advanceTime(2_000); // the cap: T0 + 10s
    await expect(h.processor().fireDueApprovalGroupWindows()).resolves.toEqual({ notified: 1 });
    await h.settle();
    expect(h.events(INTENT)).toHaveLength(1);
    expect(h.events(INTENT)[0]!.payload).toMatchObject({
      body: "Script run waiting: 5 requests (5x gmail.googleapis.com)",
    });
  });

  it("a late hold after a fired window opens a NEW window whose push counts the FULL open set", async () => {
    const h = makeNotificationHarness();
    await h.play([
      "append",
      NOTIFICATION_CREATED,
      scriptHold({ executionId: "straggler" }),
      scriptHold({ executionId: "straggler" }),
    ]);
    await h.play(["advanceTime", APPROVAL_GROUP_DEBOUNCE_WINDOW_MS], () =>
      h.processor().fireDueApprovalGroupWindows(),
    );
    expect(h.events(INTENT)).toHaveLength(1);

    // One member resolves; the other stays open. Then the script drips one more.
    await h.play(
      [
        "append",
        {
          type: "events.iterate.com/project/human-approval-granted",
          payload: { approvalRequestEventOffset: 2 },
        },
      ],
      ["advanceTime", 20_000],
      ["append", scriptHold({ executionId: "straggler" })],
    );
    expect(h.state().approvalGroups["straggler"]).toMatchObject({
      window: { firstHeldOffset: 6 },
    });

    await h.play(["advanceTime", APPROVAL_GROUP_DEBOUNCE_WINDOW_MS], () =>
      h.processor().fireDueApprovalGroupWindows(),
    );
    const pushes = h.events(INTENT);
    expect(pushes).toHaveLength(2);
    // The straggler push is a statement about the world, not a changelog: it
    // counts the unresolved first-window member too, under a fresh key.
    expect(pushes[1]).toMatchObject({
      idempotencyKey: "notification/approval-group@straggler:6",
      payload: { body: "Script run waiting: 2 requests (2x gmail.googleapis.com)" },
    });
  });

  it("resolving every member before the window fires suppresses the push and prunes the state", async () => {
    const h = makeNotificationHarness();
    await h.play([
      "append",
      NOTIFICATION_CREATED,
      scriptHold({ executionId: "live-tailed" }),
      scriptHold({ executionId: "live-tailed" }),
      {
        type: "events.iterate.com/project/human-approval-rejected",
        payload: { approvalRequestEventOffset: 2, reason: "human" },
      },
      {
        type: "events.iterate.com/project/human-approval-rejected",
        payload: { approvalRequestEventOffset: 3, reason: "human" },
      },
    ]);

    // All members resolved — nothing left to push, entry pruned immediately.
    expect(h.state().approvalGroups).toEqual({});
    expect(h.repointAlarm).toHaveBeenLastCalledWith(null);
    await h.play(["advanceTime", APPROVAL_GROUP_DEBOUNCE_WINDOW_MS], () =>
      h.processor().fireDueApprovalGroupWindows(),
    );
    expect(h.events(INTENT)).toHaveLength(0);
  });

  it("members expired at fire time suppress the push; the expiry rejections prune, and re-checks stay bounded meanwhile", async () => {
    const h = makeNotificationHarness();
    await h.play([
      "append",
      NOTIFICATION_CREATED,
      scriptHold({ executionId: "impatient", expiresAt: new Date(T0 + 1_000).toISOString() }),
    ]);

    await h.advanceTime(APPROVAL_GROUP_DEBOUNCE_WINDOW_MS);
    await expect(h.processor().fireDueApprovalGroupWindows()).resolves.toEqual({ notified: 0 });
    // The window cannot close without an event, so the wake re-arms one
    // debounce window out (a bounded re-check, not a hot loop) while the
    // egress door's expiry rejection is in flight.
    expect(h.repointAlarm).toHaveBeenLastCalledWith(T0 + APPROVAL_GROUP_DEBOUNCE_WINDOW_MS * 2);

    await h.play([
      "append",
      {
        type: "events.iterate.com/project/human-approval-rejected",
        payload: { approvalRequestEventOffset: 2, reason: "expired" },
      },
    ]);
    expect(h.state().approvalGroups).toEqual({});
    expect(h.events(INTENT)).toHaveLength(0);
    expect(h.repointAlarm).toHaveBeenLastCalledWith(null);
  });

  it("grant + settle of every member prunes the group after its window fired", async () => {
    const h = makeNotificationHarness();
    await h.play(["append", NOTIFICATION_CREATED, scriptHold({ executionId: "done" })]);
    await h.play(["advanceTime", APPROVAL_GROUP_DEBOUNCE_WINDOW_MS], () =>
      h.processor().fireDueApprovalGroupWindows(),
    );
    expect(h.events(INTENT)).toHaveLength(1);
    expect(h.events(INTENT)[0]!.payload).toMatchObject({
      title: "Approval needed",
      body: "Script run waiting: 1 request (1x gmail.googleapis.com)",
    });

    await h.play([
      "append",
      {
        type: "events.iterate.com/project/human-approval-granted",
        payload: { approvalRequestEventOffset: 2 },
      },
      {
        type: "events.iterate.com/project/human-approval-settled",
        payload: { approvalRequestEventOffset: 2, status: 200 },
      },
    ]);
    expect(h.state().approvalGroups).toEqual({});
    expect(h.repointAlarm).toHaveBeenLastCalledWith(null);
  });

  it("concurrent script runs debounce independently, one push each", async () => {
    const h = makeNotificationHarness();
    await h.play([
      "append",
      NOTIFICATION_CREATED,
      scriptHold({ executionId: "exec-a" }),
      scriptHold({ executionId: "exec-b", url: "https://api.stripe.com/v1/transfers" }),
    ]);
    await h.play(["advanceTime", APPROVAL_GROUP_DEBOUNCE_WINDOW_MS], () =>
      h.processor().fireDueApprovalGroupWindows(),
    );

    expect(h.events(INTENT).map((event) => event.payload)).toMatchObject([
      { destination: { kind: "approvals-group", executionId: "exec-a" } },
      { destination: { kind: "approvals-group", executionId: "exec-b" } },
    ]);
  });
});

// -----------------------------------------------------------------------------
// Fixtures: the generic harness plus the processor's dials (virtual clock via
// the harness, spy alarm — wakes are direct fireDueApprovalGroupWindows()
// calls, exactly what the project DO's alarm() does).
// -----------------------------------------------------------------------------

/** The generic harness on the project ROOT stream — where this processor is
 * registered in production, and what the idempotency keys embed. */
function makeNotificationHarness(substrateOverride?: HarnessSubstrate) {
  const repointAlarm = vi.fn(async (_atMs: number | null) => {});
  const substrate: HarnessSubstrate = substrateOverride || {
    clock: { now: T0 },
    stream: new MemoryStream("/"),
    progress: makeMemoryProgressStore(),
  };
  const harness = makeProcessorHarness<NotificationProcessorContract, NotificationProcessor>({
    createProcessor: (deps) => new NotificationProcessor({ ...deps, repointAlarm }),
    substrate,
  });
  return { ...harness, repointAlarm };
}

/** One held request carrying script-execution provenance — an Approval Group member. */
function scriptHold(input: {
  executionId: string;
  url?: string;
  expiresAt?: string;
}): NotificationEventInput {
  return {
    type: "events.iterate.com/project/human-approval-requested",
    payload: {
      method: "POST",
      url: input.url || "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
      headers: {},
      body: null,
      secretPaths: [],
      ruleKey: "gmail-sends",
      ruleDescription: "Gmail sends need a human",
      expiresAt: input.expiresAt || "2026-07-19T08:05:00.000Z",
      streamContext: {
        kind: "script-execution",
        streamPath: "/agents/demo",
        scriptRunRequestedEventOffset: 1,
        executionId: input.executionId,
      },
    },
  };
}
