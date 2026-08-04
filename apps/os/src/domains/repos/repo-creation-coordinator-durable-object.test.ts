import { describe, expect, it, vi } from "vitest";
import type { Env } from "../../env.ts";
import { DurableObjectNameCodec } from "../durable-object-names.ts";

vi.mock("../../env.ts", () => ({ workerVersion: () => "test-version" }));

const { RepoCreationCoordinatorDurableObject } =
  await import("./repo-creation-coordinator-durable-object.ts");

const repoName = DurableObjectNameCodec.stringify({
  path: "/repos/config",
  projectId: "prj_test",
});

function coordinator(records = new Map<string, unknown>()) {
  const continueCreation = vi.fn(async () => undefined);
  const getByName = vi.fn(() => ({ continueCreation }));
  const setAlarm = vi.fn(async () => undefined);
  const ctx = {
    id: { name: repoName },
    storage: {
      kv: {
        delete: (key: string) => records.delete(key),
        get: <T>(key: string) => records.get(key) as T | undefined,
        put: (key: string, value: unknown) => records.set(key, value),
      },
      setAlarm,
    },
  } as unknown as DurableObjectState;
  const env = { REPO: { getByName } } as unknown as Env;
  return {
    continueCreation,
    getByName,
    records,
    setAlarm,
    value: new RepoCreationCoordinatorDurableObject(ctx, env),
  };
}

describe("RepoCreationCoordinatorDurableObject handoff", () => {
  it("persists and arms creation without doing vendor work in the caller RPC", async () => {
    const h = coordinator();

    await h.value.enqueue();

    expect([...h.records.values()]).toEqual([true]);
    expect(h.setAlarm).toHaveBeenCalledOnce();
    expect(h.continueCreation).not.toHaveBeenCalled();
  });

  it("preserves an existing attempt and its retry deadline across duplicate enqueue calls", async () => {
    const h = coordinator();

    await h.value.enqueue();
    await h.value.enqueue();

    expect(h.setAlarm).toHaveBeenCalledOnce();
    expect([...h.records.values()]).toEqual([true]);
  });

  it("calls the matching Repo from its alarm and clears completed work", async () => {
    const h = coordinator();
    await h.value.enqueue();

    await h.value.alarm();

    expect(h.getByName).toHaveBeenCalledWith(repoName);
    expect(h.continueCreation).toHaveBeenCalledOnce();
    expect(h.records.size).toBe(0);
  });

  it("retains and re-arms retryable work while surfacing the failed attempt", async () => {
    const h = coordinator();
    const failure = new Error("GitHub unavailable");
    h.continueCreation.mockRejectedValueOnce(failure);
    await h.value.enqueue();

    await expect(h.value.alarm()).rejects.toBe(failure);
    expect([...h.records.values()]).toEqual([true]);
    expect(h.setAlarm).toHaveBeenCalledTimes(2);

    await expect(h.value.alarm()).resolves.toBeUndefined();
    expect(h.records.size).toBe(0);
  });
});
