// Scheduler e2e: the full loop through a real deployment — itx.scheduler.set
// arms a Durable Object alarm, the alarm requests a Trigger, the itx script
// runs in a dynamic worker with project-root authority, and both the outcome
// and the script's cross-stream side effect land as events.

import { expect, test } from "vitest";
import type { ScheduleView, StreamEvent } from "../../src/types.ts";
import { waitForCondition } from "../test-support/wait-for-condition.ts";
import { adminSecret, withItxSession } from "./test-helpers.ts";

const RUN_SUFFIX = crypto.randomUUID().slice(0, 8);
const SCHEDULER_STREAM_PATH = "/scheduler/primary";
const COMPLETED_TYPE = "events.iterate.com/scheduler/trigger-completed";
const MARKER_TYPE = "events.iterate.test/scheduler-e2e/marker";

test("a near-future schedule triggers, runs its itx script, and records the outcome", async () => {
  const marker = crypto.randomUUID();
  const key = `e2e/near-future/${marker}`;
  const targetPath = `/e2e/scheduler/${marker}`;

  using session = withItxSession();
  using itx = session.authenticate({ type: "admin-secret", secret: adminSecret() });
  using project = itx.projects.create({
    slug: `scheduler-e2e-${RUN_SUFFIX}-${marker.slice(0, 8)}`,
  });

  const view = await project.scheduler.set({
    key,
    // `{ in }` sugar lowers to a canonical `{ at }` before anything is appended.
    recurrence: { in: 2 },
    // The script exercises the real authority path: a cross-stream append via
    // the project-root itx, idempotency-keyed by executionId per the contract.
    script: `async (itx, schedule, trigger) => {
      await itx.streams.get(${JSON.stringify(targetPath)}).append({
        type: ${JSON.stringify(MARKER_TYPE)},
        idempotencyKey: "marker:" + trigger.executionId,
        payload: { key: schedule.key, marker: ${JSON.stringify(marker)}, runCount: trigger.runCount },
      });
      return { marker: ${JSON.stringify(marker)} };
    }`,
    metadata: { suite: "scheduler-e2e" },
  });
  // set() is read-your-writes: the returned view proves ingestion + arming.
  expect(view.key).toBe(key);
  expect(view.nextTriggerAt).not.toBeNull();
  expect("at" in view.recurrence).toBe(true);

  const listed = await project.scheduler.list();
  expect(listed.map((schedule: ScheduleView) => schedule.key)).toContain(key);

  using schedulerStream = project.streams.get(SCHEDULER_STREAM_PATH);
  let completed: StreamEvent | undefined;
  await waitFor(
    async () => {
      const events = await schedulerStream.getEvents({ afterOffset: 0 });
      completed = events.find(
        (event) => event.type === COMPLETED_TYPE && (event.payload as { key?: string }).key === key,
      );
      return completed !== undefined;
    },
    () => `trigger-completed for ${key} on ${SCHEDULER_STREAM_PATH}`,
  );
  expect(completed!.payload).toMatchObject({
    key,
    outcome: "succeeded",
    result: { marker },
  });

  // The cross-stream side effect the script performed.
  const markerEvents = await project.streams.get(targetPath).getEvents({ afterOffset: 0 });
  expect(markerEvents).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        payload: { key, marker, runCount: 1 },
        type: MARKER_TYPE,
      }),
    ]),
  );

  // A one-shot leaves the list once its trigger settles.
  await waitFor(
    async () => {
      const remaining = await project.scheduler.list();
      return !remaining.some((schedule: ScheduleView) => schedule.key === key);
    },
    () => `one-shot ${key} to leave the schedule list`,
  );
});

test("manual trigger runs a far-future schedule now; cancel removes it", async () => {
  const marker = crypto.randomUUID();
  const key = `e2e/manual/${marker}`;

  using session = withItxSession();
  using itx = session.authenticate({ type: "admin-secret", secret: adminSecret() });
  using project = itx.projects.create({
    slug: `scheduler-manual-e2e-${RUN_SUFFIX}-${marker.slice(0, 8)}`,
  });

  await project.scheduler.set({
    key,
    recurrence: { cron: "0 3 1 1 *", timezone: "Europe/London" }, // far future: yearly
    script: `async (itx, schedule, trigger) => "manual-" + trigger.runCount`,
  });

  const { executionId } = await project.scheduler.trigger(key);
  using schedulerStream = project.streams.get(SCHEDULER_STREAM_PATH);
  let completed: StreamEvent | undefined;
  await waitFor(
    async () => {
      const events = await schedulerStream.getEvents({ afterOffset: 0 });
      completed = events.find(
        (event) =>
          event.type === COMPLETED_TYPE &&
          (event.payload as { executionId?: string }).executionId === executionId,
      );
      return completed !== undefined;
    },
    () => `manual trigger-completed ${executionId} for ${key}`,
  );
  expect(completed!.payload).toMatchObject({ outcome: "succeeded", result: "manual-1" });

  await project.scheduler.cancel(key);
  const listed = await project.scheduler.list();
  expect(listed.map((schedule: ScheduleView) => schedule.key)).not.toContain(key);
});

function waitFor(
  predicate: () => boolean | Promise<boolean>,
  describe: () => string,
  timeoutMs = 60_000,
) {
  return waitForCondition(predicate, { description: describe, intervalMs: 500, timeoutMs });
}
