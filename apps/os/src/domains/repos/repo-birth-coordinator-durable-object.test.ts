import { expect, test, vi } from "vitest";
import {
  isRetryableRepoBirthError,
  RepoBirthCoordinator,
} from "./repo-birth-coordinator-durable-object.ts";

const REQUEST = { type: "empty" as const };
const HANDOFF = {
  request: REQUEST,
  streamId: "11111111-1111-4111-8111-111111111111",
};
const ARTIFACT = {
  artifactName: "prj_test--L3JlcG9zL2NvbmZpZw",
  defaultBranch: "main",
  remote: "https://account.artifacts.cloudflare.net/git/ns/prj_test.git",
  seededHead: {
    branch: "main",
    commitOid: "seed-oid",
    contentHash: "seed-content-hash",
  },
};

test("enqueue persists the fenced obligation and only arms the alarm", async () => {
  const h = coordinator();

  await h.value.enqueue(HANDOFF);

  expect(h.queued()).toEqual({ ...HANDOFF, failedAttempts: 0 });
  expect(h.setAlarm).toHaveBeenCalledOnce();
  expect(h.materialize).not.toHaveBeenCalled();
  expect(h.append).not.toHaveBeenCalled();
});

test("alarm materializes once, checkpoints it, and appends the fenced birth certificate", async () => {
  const h = coordinator();
  await h.value.enqueue(HANDOFF);

  await h.value.alarm();

  expect(h.materialize).toHaveBeenCalledOnce();
  expect(h.append).toHaveBeenCalledWith(HANDOFF.streamId, {
    type: "events.iterate.com/repos/created",
    idempotencyKey: "repo/created",
    payload: { ...ARTIFACT, request: REQUEST },
  });
  expect(h.queued()).toBeUndefined();
});

test("a lost terminal acknowledgement resumes from the materialized checkpoint", async () => {
  const first = coordinator();
  await first.value.enqueue(HANDOFF);
  first.append.mockRejectedValueOnce(new Error("stream reset before acknowledgement"));

  await expect(first.value.alarm()).rejects.toThrow("stream reset before acknowledgement");
  expect(first.queued()).toEqual({
    ...HANDOFF,
    failedAttempts: 0,
    materializedArtifact: ARTIFACT,
  });

  const recovered = coordinator(first.records);
  await recovered.value.alarm();

  expect(recovered.materialize).not.toHaveBeenCalled();
  expect(recovered.append).toHaveBeenCalledOnce();
  expect(recovered.queued()).toBeUndefined();
});

test("a classified terminal-append outage preserves the materialized checkpoint", async () => {
  const h = coordinator();
  await h.value.enqueue(HANDOFF);
  h.append.mockRejectedValueOnce(
    Object.assign(new Error("Stream unavailable"), { retryable: true }),
  );

  await expect(h.value.alarm()).resolves.toBeUndefined();

  expect(h.queued()).toEqual({
    ...HANDOFF,
    failedAttempts: 1,
    materializedArtifact: ARTIFACT,
  });
  expect(h.setAlarm).toHaveBeenCalledTimes(2);
});

test("a classified outage re-arms explicitly without emitting error telemetry", async () => {
  const h = coordinator();
  await h.value.enqueue(HANDOFF);
  h.materialize.mockRejectedValueOnce(
    Object.assign(new Error("Artifacts 503"), { retryable: true }),
  );

  await expect(h.value.alarm()).resolves.toBeUndefined();

  expect(h.queued()).toEqual({ ...HANDOFF, failedAttempts: 1 });
  expect(h.setAlarm).toHaveBeenCalledTimes(2);
  expect(h.append).not.toHaveBeenCalled();
});

test("the property-stripped hosted Artifacts 503 remains a classified retry", () => {
  expect(isRetryableRepoBirthError(new Error("HTTP Error: 503 Service Unavailable"))).toBe(true);
});

test("an obsolete stream lifetime is dropped before Artifacts work", async () => {
  const h = coordinator();
  await h.value.enqueue(HANDOFF);
  h.getEventPage.mockResolvedValueOnce({
    events: [committedRequest()],
    streamId: "22222222-2222-4222-8222-222222222222",
  });

  await h.value.alarm();

  expect(h.materialize).not.toHaveBeenCalled();
  expect(h.append).not.toHaveBeenCalled();
  expect(h.queued()).toBeUndefined();
});

function committedRequest() {
  return {
    createdAt: new Date(0).toISOString(),
    offset: 1,
    path: "/repos/config",
    payload: REQUEST,
    type: "events.iterate.com/repos/create-requested",
  };
}

function coordinator(records = new Map<string, unknown>()) {
  let alarmAt: number | null = null;
  const setAlarm = vi.fn(async (scheduledTime: number) => {
    alarmAt = scheduledTime;
  });
  const getEventPage = vi.fn(async () => ({
    events: [committedRequest()],
    streamId: HANDOFF.streamId,
  }));
  const materialize = vi.fn(async () => ARTIFACT);
  const append = vi.fn(async () => undefined);
  const value = new RepoBirthCoordinator({
    append,
    deleteQueue: () => void records.delete("repo-birth:queued"),
    getAlarm: async () => alarmAt,
    getEventPage,
    getQueue: () => records.get("repo-birth:queued"),
    isRetryableError: (error) => (error as { retryable?: boolean }).retryable === true,
    materialize,
    now: () => 1_000,
    putQueue: (queued) => void records.set("repo-birth:queued", queued),
    setAlarm,
  });
  return {
    append,
    getEventPage,
    materialize,
    queued: () => records.get("repo-birth:queued"),
    records,
    setAlarm,
    value,
  };
}
