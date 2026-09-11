import { expect, test, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({
  RpcTarget: class {},
}));

import { DurableObjectNameCodec } from "./context/durable-object-names.ts";
import { IterateContext, type IterateContextNamespace } from "./iterate-context.ts";
import { ContextLeaseBook } from "./session.ts";

type FakeDurableObject = {
  invoke: ReturnType<typeof vi.fn>;
  fetch: ReturnType<typeof vi.fn>;
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

function contextWith(...durableObjects: FakeDurableObject[]): IterateContext {
  const getByName = vi.fn(() => {
    const durableObject = durableObjects.shift();
    if (!durableObject) throw new Error("test exhausted its Durable Object stubs");
    return durableObject;
  });
  return new IterateContext(
    { getByName } as unknown as IterateContextNamespace,
    DurableObjectNameCodec.parse("prj_recovery"),
    new ContextLeaseBook(),
    vi.fn(),
  );
}

function durableObject(): FakeDurableObject {
  return { invoke: vi.fn(), fetch: vi.fn() };
}

test("a healthy public context keeps its one Durable Object stub in call order", async () => {
  const durable = durableObject();
  durable.invoke.mockResolvedValueOnce("first").mockResolvedValueOnce("second");
  const context = contextWith(durable);

  await expect(context.invoke(["itx", ["first"]])).resolves.toBe("first");
  await expect(context.invoke(["itx", ["second"]])).resolves.toBe("second");

  expect(durable.invoke.mock.calls).toEqual([[["itx", ["first"]]], [["itx", ["second"]]]]);
});

test("a failed public append rethrows its original error and the next call uses a fresh Durable Object stub", async () => {
  const failed = durableObject();
  const recovered = durableObject();
  const original = Object.assign(new Error("native DO reset"), { retryable: true });
  failed.invoke.mockRejectedValueOnce(original);
  recovered.invoke.mockResolvedValueOnce("recovered");
  const context = contextWith(failed, recovered);

  await expect(context.invoke(["itx", ["append", { type: "first" }]])).rejects.toBe(original);
  await expect(context.invoke(["itx", ["whoami"]])).resolves.toBe("recovered");

  expect(failed.invoke).toHaveBeenCalledTimes(1);
  expect(recovered.invoke).toHaveBeenCalledWith(["itx", ["whoami"]]);
});

test("a late failure from an old stub cannot discard its replacement", async () => {
  const old = durableObject();
  const replacement = durableObject();
  const first = deferred<unknown>();
  const second = deferred<unknown>();
  const firstError = new Error("first failed");
  const secondError = new Error("late old failure");
  old.invoke.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  replacement.invoke.mockResolvedValueOnce("fresh").mockResolvedValueOnce("still fresh");
  const context = contextWith(old, replacement);

  const firstCall = context.invoke(["itx", ["first"]]);
  const lateOldCall = context.invoke(["itx", ["late"]]);
  first.reject(firstError);
  await expect(firstCall).rejects.toBe(firstError);
  await expect(context.invoke(["itx", ["fresh"]])).resolves.toBe("fresh");
  second.reject(secondError);
  await expect(lateOldCall).rejects.toBe(secondError);
  await expect(context.invoke(["itx", ["after"]])).resolves.toBe("still fresh");

  expect(replacement.invoke.mock.calls).toEqual([[["itx", ["fresh"]]], [["itx", ["after"]]]]);
});

test("a failed public fetch invalidates its Durable Object stub", async () => {
  const failed = durableObject();
  const recovered = durableObject();
  const original = new Error("native fetch failed");
  failed.fetch.mockRejectedValueOnce(original);
  recovered.invoke.mockResolvedValueOnce("recovered");
  const context = contextWith(failed, recovered);

  await expect(
    context.invoke(["itx", "site", ["fetch", new Request("https://example.test/")]]),
  ).rejects.toBe(original);
  await expect(context.invoke(["itx", ["after-fetch"]])).resolves.toBe("recovered");

  expect(recovered.invoke).toHaveBeenCalledWith(["itx", ["after-fetch"]]);
});

test("a failed direct provide append invalidates its Durable Object stub", async () => {
  const failed = durableObject();
  const recovered = durableObject();
  const original = new Error("native append failed");
  failed.invoke.mockRejectedValueOnce(original);
  recovered.invoke.mockResolvedValueOnce("recovered");
  const context = contextWith(failed, recovered);

  await expect(context.provide("itx.alias", "itx.whoami")).rejects.toBe(original);
  await expect(context.invoke(["itx", ["after-provide"]])).resolves.toBe("recovered");

  expect(recovered.invoke).toHaveBeenCalledWith(["itx", ["after-provide"]]);
});
