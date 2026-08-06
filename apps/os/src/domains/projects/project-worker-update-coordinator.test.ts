import { expect, test, vi } from "vitest";
import { StreamIdMismatchError, streamIdMismatchMessage } from "iterate/processors";
import { internalStreamId } from "../streams/stream-delivery-utils.ts";
import { WorkerBuildFailedError } from "../workers/artifact-store.ts";
import { ProjectWorkerUpdateCoordinator } from "./project-worker-update-coordinator.ts";

const HANDOFF = { commitOid: "b".repeat(40), streamId: crypto.randomUUID() };

test("a config commit is durably handed off before its worker is probed", async () => {
  const h = coordinator();

  await h.value.enqueue(HANDOFF);

  expect(h.records.queue).toMatchObject([{ ...HANDOFF, failedAttempts: 0 }]);
  expect(h.probe).not.toHaveBeenCalled();
  expect(h.records.alarmAt).toBe(h.clock.now + 1_000);
});

test("a redelivered handoff keeps one queued update", async () => {
  const h = coordinator();

  await h.value.enqueue(HANDOFF);
  await h.value.enqueue(HANDOFF);

  expect(h.records.queue).toMatchObject([{ ...HANDOFF, failedAttempts: 0 }]);
});

test("the independent alarm probes and appends the served worker identity through the stream fence", async () => {
  const h = coordinator();
  await h.value.enqueue(HANDOFF);

  await h.value.alarm();

  expect(h.append).toHaveBeenCalledWith(HANDOFF.streamId, {
    type: "events.iterate.com/project/worker-updated",
    idempotencyKey: internalStreamId("project-worker-update", HANDOFF.commitOid),
    payload: { commitOid: "c".repeat(40) },
  });
  expect(h.records.queue).toBeUndefined();
  expect(h.records.alarmAt).toBeNull();
});

test("a lost append acknowledgement reuses the checkpointed outcome without probing again", async () => {
  const outage = Object.assign(new Error("stream incarnation reset after commit"), {
    durableObjectReset: true,
  });
  const h = coordinator({ appendOutcomes: [outage] });
  await h.value.enqueue(HANDOFF);

  await h.value.alarm();
  await h.value.alarm();

  expect(h.probe).toHaveBeenCalledOnce();
  expect(h.append).toHaveBeenCalledTimes(2);
  expect(h.records.queue).toBeUndefined();
});

test("a stream reset discards the obsolete fenced update", async () => {
  const h = coordinator({
    appendOutcomes: [new StreamIdMismatchError(streamIdMismatchMessage("old", "new"))],
  });
  await h.value.enqueue(HANDOFF);

  await h.value.alarm();

  expect(h.records.queue).toBeUndefined();
  expect(h.records.alarmAt).toBeNull();
});

test("a deterministic worker build failure becomes a durable lifecycle outcome", async () => {
  const h = coordinator({
    probeOutcomes: [new WorkerBuildFailedError({ kind: "source", message: "Expected ;" })],
  });
  await h.value.enqueue(HANDOFF);

  await h.value.alarm();

  expect(h.append).toHaveBeenCalledWith(HANDOFF.streamId, {
    type: "events.iterate.com/project/worker-update-failed",
    idempotencyKey: internalStreamId("project-worker-update", HANDOFF.commitOid),
    payload: { commitOid: HANDOFF.commitOid, error: "Expected ;" },
  });
});

test("classified availability is retried from the queue, then completes", async () => {
  const outage = Object.assign(new Error("dynamic worker temporarily overloaded"), {
    overloaded: true,
  });
  const h = coordinator({ probeOutcomes: [outage] });
  await h.value.enqueue(HANDOFF);

  await h.value.alarm();
  expect(h.records.queue).toMatchObject([{ ...HANDOFF, failedAttempts: 1 }]);
  expect(h.records.alarmAt).toBe(h.clock.now + 10_000);

  await h.value.alarm();
  expect(h.append).toHaveBeenCalledOnce();
  expect(h.records.queue).toBeUndefined();
});

test("the fifth classified readiness failure becomes one durable terminal outcome", async () => {
  const outages = Array.from({ length: 5 }, () =>
    Object.assign(new Error("dynamic worker temporarily overloaded"), { overloaded: true }),
  );
  const h = coordinator({ probeOutcomes: outages });
  await h.value.enqueue(HANDOFF);

  for (let attempt = 0; attempt < 5; attempt += 1) await h.value.alarm();

  expect(h.append).toHaveBeenCalledWith(HANDOFF.streamId, {
    type: "events.iterate.com/project/worker-update-failed",
    idempotencyKey: internalStreamId("project-worker-update", HANDOFF.commitOid),
    payload: {
      commitOid: HANDOFF.commitOid,
      error:
        "Default worker readiness failed after 5 attempts: dynamic worker temporarily overloaded",
    },
  });
  expect(h.records.queue).toBeUndefined();
});

test("an unexplained probe failure stays visible while retaining a bounded durable retry", async () => {
  const h = coordinator({ probeOutcomes: [new Error("broken readiness protocol")] });
  await h.value.enqueue(HANDOFF);

  await expect(h.value.alarm()).rejects.toThrow("broken readiness protocol");

  expect(h.records.queue).toMatchObject([{ ...HANDOFF, failedAttempts: 1 }]);
  expect(h.records.alarmAt).toBe(h.clock.now + 10_000);
});

test("a config commit arriving during an alarm probe remains queued after that alarm commits", async () => {
  let releaseProbe!: (commitOid: string) => void;
  const probeBarrier = new Promise<string>((resolve) => {
    releaseProbe = resolve;
  });
  const h = coordinator({ probeBarrier });
  await h.value.enqueue(HANDOFF);

  const alarm = h.value.alarm();
  await vi.waitFor(() => expect(h.probe).toHaveBeenCalledOnce());
  const next = { commitOid: "d".repeat(40), streamId: HANDOFF.streamId };
  const enqueue = h.value.enqueue(next);
  releaseProbe("c".repeat(40));
  await Promise.all([alarm, enqueue]);

  expect(h.records.queue).toMatchObject([{ ...next, failedAttempts: 0 }]);
});

function coordinator(
  options: {
    appendOutcomes?: Error[];
    probeBarrier?: Promise<string>;
    probeOutcomes?: Error[];
  } = {},
) {
  const clock = { now: 1_000 };
  const records: { alarmAt: number | null; queue?: unknown } = { alarmAt: null };
  let appendCalls = 0;
  let probeCalls = 0;
  const append = vi.fn(async () => {
    const outcome = options.appendOutcomes?.[appendCalls];
    appendCalls += 1;
    if (outcome !== undefined) throw outcome;
  });
  const probe = vi.fn(async () => {
    if (probeCalls === 0 && options.probeBarrier !== undefined) {
      probeCalls += 1;
      return await options.probeBarrier;
    }
    const outcome = options.probeOutcomes?.[probeCalls];
    probeCalls += 1;
    if (outcome !== undefined) throw outcome;
    return "c".repeat(40);
  });
  const value = new ProjectWorkerUpdateCoordinator({
    append,
    clearAlarm: async () => void (records.alarmAt = null),
    deleteQueue: () => delete records.queue,
    getAlarm: () => records.alarmAt,
    getQueue: () => structuredClone(records.queue),
    isRetryableError: (error) =>
      (error as { durableObjectReset?: boolean; overloaded?: boolean }).durableObjectReset ===
        true ||
      (error as { durableObjectReset?: boolean; overloaded?: boolean }).overloaded === true,
    now: () => clock.now,
    probe,
    putQueue: (queue) => void (records.queue = structuredClone(queue)),
    setAlarm: async (atMs) => void (records.alarmAt = atMs),
  });
  return { append, clock, probe, records, value };
}
