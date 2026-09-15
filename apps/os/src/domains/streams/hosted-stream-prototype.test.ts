import { expect, test, vi } from "vitest";
import { HostedAlarmRelay } from "./hosted-stream-prototype.ts";

test("keeps a failed hosted alarm visible to concurrent waiters until a newer arm commits", async () => {
  const first = Promise.withResolvers<void>();
  const second = Promise.withResolvers<void>();
  const host = {
    deleteHostedStreamAlarm: vi.fn(async () => undefined),
    getHostedStreamAlarm: vi.fn(async () => null),
    setHostedStreamAlarm: vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise),
  };
  const relay = new HostedAlarmRelay(host, "prj_test/hosted-stream-prototype/one");

  relay.setAlarm(1);
  first.reject(new Error("first parent write rejected"));
  const failed = await Promise.allSettled([
    relay.flushRequiredWrites(),
    relay.flushRequiredWrites(),
  ]);
  expect(failed.map((result) => result.status)).toEqual(["rejected", "rejected"]);
  // A later boundary must not slip through before the rejected arm is repaired.
  await expect(relay.flushRequiredWrites()).rejects.toThrow("hosted stream alarm write failed");

  relay.setAlarm(2);
  second.resolve();
  await expect(relay.flushRequiredWrites()).resolves.toBeUndefined();
});

test("does not let a late old success erase a newer failed hosted alarm", async () => {
  const oldWrite = Promise.withResolvers<void>();
  const newWrite = Promise.withResolvers<void>();
  const host = {
    deleteHostedStreamAlarm: vi.fn(async () => undefined),
    getHostedStreamAlarm: vi.fn(async () => null),
    setHostedStreamAlarm: vi
      .fn()
      .mockReturnValueOnce(oldWrite.promise)
      .mockReturnValueOnce(newWrite.promise),
  };
  const relay = new HostedAlarmRelay(host, "prj_test/hosted-stream-prototype/one");

  relay.setAlarm(1);
  relay.setAlarm(2);
  newWrite.reject(new Error("new parent write rejected"));
  oldWrite.resolve();

  await expect(relay.flushRequiredWrites()).rejects.toThrow("hosted stream alarm write failed");
});

test("coalesces redundant hosted disarms after the host confirms the record is empty", async () => {
  const host = {
    deleteHostedStreamAlarm: vi.fn(async () => undefined),
    getHostedStreamAlarm: vi.fn(async () => null),
    setHostedStreamAlarm: vi.fn(async () => undefined),
  };
  const relay = new HostedAlarmRelay(host, "prj_test/hosted-stream-prototype/one");

  await relay.deleteAlarm();
  await relay.deleteAlarm();
  expect(host.deleteHostedStreamAlarm).toHaveBeenCalledOnce();
});

test("orders a fresh hosted arm after an earlier clear", async () => {
  const clear = Promise.withResolvers<void>();
  const calls: string[] = [];
  const host = {
    deleteHostedStreamAlarm: vi.fn(async () => {
      calls.push("delete");
      await clear.promise;
    }),
    getHostedStreamAlarm: vi.fn(async () => null),
    setHostedStreamAlarm: vi.fn(async () => {
      calls.push("set");
    }),
  };
  const relay = new HostedAlarmRelay(host, "prj_test/hosted-stream-prototype/one");

  relay.deleteAlarm();
  relay.setAlarm(10);
  await Promise.resolve();
  expect(calls).toEqual(["delete"]);

  clear.resolve();
  await relay.flushRequiredWrites();
  expect(calls).toEqual(["delete", "set"]);
});

test("coalesces quiet clears while the parent delete is still pending", async () => {
  const pendingDelete = Promise.withResolvers<void>();
  const host = {
    deleteHostedStreamAlarm: vi.fn(() => pendingDelete.promise),
    getHostedStreamAlarm: vi.fn(async () => null),
    setHostedStreamAlarm: vi.fn(async () => undefined),
  };
  const relay = new HostedAlarmRelay(host, "prj_test/hosted-stream-prototype/one");
  const clears = Array.from({ length: 50 }, () => relay.deleteAlarm());
  await Promise.resolve();
  expect(host.deleteHostedStreamAlarm).toHaveBeenCalledOnce();
  pendingDelete.resolve();
  await Promise.all(clears);
  expect(host.deleteHostedStreamAlarm).toHaveBeenCalledOnce();
});

test("repairs a failed arm once before an idempotent retry can acknowledge", async () => {
  const host = {
    deleteHostedStreamAlarm: vi.fn(async () => undefined),
    getHostedStreamAlarm: vi.fn(async () => null),
    setHostedStreamAlarm: vi
      .fn()
      .mockRejectedValueOnce(new Error("first arm failed"))
      .mockResolvedValue(undefined),
  };
  const relay = new HostedAlarmRelay(host, "prj_test/hosted-stream-prototype/one");

  relay.setAlarm(1);
  await expect(relay.flushRequiredWrites()).rejects.toThrow("hosted stream alarm write failed");

  await relay.repairFailedArm(2);
  await expect(relay.flushRequiredWrites()).resolves.toBeUndefined();
  expect(host.setHostedStreamAlarm).toHaveBeenNthCalledWith(1, {
    atMs: 1,
    logicalName: "prj_test/hosted-stream-prototype/one",
  });
  expect(host.setHostedStreamAlarm).toHaveBeenNthCalledWith(2, {
    atMs: 2,
    logicalName: "prj_test/hosted-stream-prototype/one",
  });
});

test("coalesces concurrent repairs after one failed hosted arm", async () => {
  const repair = Promise.withResolvers<void>();
  const host = {
    deleteHostedStreamAlarm: vi.fn(async () => undefined),
    getHostedStreamAlarm: vi.fn(async () => null),
    setHostedStreamAlarm: vi
      .fn()
      .mockRejectedValueOnce(new Error("first arm failed"))
      .mockReturnValueOnce(repair.promise),
  };
  const relay = new HostedAlarmRelay(host, "prj_test/hosted-stream-prototype/one");

  relay.setAlarm(1);
  await expect(relay.flushRequiredWrites()).rejects.toThrow("hosted stream alarm write failed");
  const first = relay.repairFailedArm(2);
  const second = relay.repairFailedArm(2);
  await Promise.resolve();
  expect(host.setHostedStreamAlarm).toHaveBeenCalledTimes(2);

  repair.resolve();
  await Promise.all([first, second]);
  await expect(relay.flushRequiredWrites()).resolves.toBeUndefined();
});
