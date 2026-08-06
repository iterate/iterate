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
const PREPARED_ARTIFACT = {
  artifactName: ARTIFACT.artifactName,
  defaultBranch: ARTIFACT.defaultBranch,
  remote: ARTIFACT.remote,
  writeToken: "initial-artifact-write-token",
};

test("enqueue persists the fenced obligation and only arms the alarm", async () => {
  const h = coordinator();

  await h.value.enqueue(HANDOFF);

  expect(h.queued()).toEqual({ ...HANDOFF, failedAttempts: 0 });
  expect(h.setAlarm).toHaveBeenCalledOnce();
  expect(h.prepare).not.toHaveBeenCalled();
  expect(h.append).not.toHaveBeenCalled();
});

test("alarm materializes once, checkpoints it, and appends the fenced birth certificate", async () => {
  const h = coordinator();
  await h.value.enqueue(HANDOFF);

  await h.value.alarm();

  expect(h.prepare).toHaveBeenCalledOnce();
  expect(h.seed).toHaveBeenCalledExactlyOnceWith(PREPARED_ARTIFACT);
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

  expect(recovered.prepare).not.toHaveBeenCalled();
  expect(recovered.seed).not.toHaveBeenCalled();
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
  h.prepare.mockRejectedValueOnce(Object.assign(new Error("Artifacts 503"), { retryable: true }));

  await expect(h.value.alarm()).resolves.toBeUndefined();

  expect(h.queued()).toEqual({ ...HANDOFF, failedAttempts: 1 });
  expect(h.setAlarm).toHaveBeenCalledTimes(2);
  expect(h.append).not.toHaveBeenCalled();
});

test("a seed outage checkpoints the initial write token before retrying", async () => {
  const first = coordinator();
  await first.value.enqueue(HANDOFF);
  first.seed.mockRejectedValueOnce(
    Object.assign(new Error("Artifacts Git 503"), { retryable: true }),
  );

  await expect(first.value.alarm()).resolves.toBeUndefined();

  expect(first.queued()).toEqual({
    ...HANDOFF,
    failedAttempts: 1,
    preparedArtifact: PREPARED_ARTIFACT,
  });

  const recovered = coordinator(first.records);
  await recovered.value.alarm();

  expect(recovered.prepare).not.toHaveBeenCalled();
  expect(recovered.seed).toHaveBeenCalledExactlyOnceWith(PREPARED_ARTIFACT);
  expect(recovered.append).toHaveBeenCalledExactlyOnceWith(HANDOFF.streamId, {
    type: "events.iterate.com/repos/created",
    idempotencyKey: "repo/created",
    payload: { ...ARTIFACT, request: REQUEST },
  });
  expect(recovered.queued()).toBeUndefined();
});

test("five classified outages append one durable terminal failure", async () => {
  const h = coordinator();
  await h.value.enqueue(HANDOFF);
  h.prepare.mockRejectedValue(Object.assign(new Error("Artifacts 503"), { retryable: true }));

  for (let attempt = 0; attempt < 5; attempt += 1) await h.value.alarm();

  expect(h.setAlarm).toHaveBeenCalledTimes(5);
  expect(h.append).toHaveBeenCalledExactlyOnceWith(HANDOFF.streamId, {
    type: "events.iterate.com/repos/create-failed",
    idempotencyKey: "repo/create-failed",
    payload: {
      error: "Empty repo creation failed after 5 attempts: Artifacts 503",
      request: REQUEST,
    },
  });
  expect(h.queued()).toBeUndefined();
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

  expect(h.prepare).not.toHaveBeenCalled();
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
  const prepare = vi.fn(async () => ({
    kind: "needs-seed" as const,
    artifact: PREPARED_ARTIFACT,
  }));
  const seed = vi.fn(async () => ARTIFACT);
  const append = vi.fn(async () => undefined);
  const value = new RepoBirthCoordinator({
    append,
    deleteQueue: () => void records.delete("repo-birth:queued"),
    getAlarm: async () => alarmAt,
    getEventPage,
    getQueue: () => records.get("repo-birth:queued"),
    isRetryableError: (error) => (error as { retryable?: boolean }).retryable === true,
    now: () => 1_000,
    prepare,
    putQueue: (queued) => void records.set("repo-birth:queued", queued),
    seed,
    setAlarm,
  });
  return {
    append,
    getEventPage,
    prepare,
    queued: () => records.get("repo-birth:queued"),
    records,
    seed,
    setAlarm,
    value,
  };
}
