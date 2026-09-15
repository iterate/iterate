import { DurableObject } from "cloudflare:workers";
import { expect, test } from "vitest";
import { deploymentReadyStub, withDeploymentReadiness } from "./deployment-readiness.ts";

test("old code receives no mutation; the new incarnation executes it once", async () => {
  let version = "old";
  const counter = new (withDeploymentReadiness(Counter))(
    {} as any,
    {
      get CF_VERSION_METADATA() {
        return { id: version };
      },
    } as any,
  );
  const stub = deploymentReadyStub(counter, {
    version: "new",
    object: "PROJECT:prj_test",
    timeoutMs: 100,
    intervalMs: 1,
  });
  const increment = stub.increment(3);
  await Promise.resolve();
  expect(counter.value).toBe(0);
  version = "new";
  expect(await increment).toBe(3);
  expect(counter.value).toBe(3);
});

test("a deployment between the probe and operation still cannot mutate old code", async () => {
  const counter = new (withDeploymentReadiness(Counter))(
    {} as any,
    { CF_VERSION_METADATA: { id: "old" } } as any,
  );
  // Model the caller having observed new code, then being routed to a
  // mismatching incarnation. The receiving guard is the production method.
  expect(await (counter as any).callAtVersion("new", "increment", [3])).toEqual({
    ready: false,
    version: "old",
  });
  expect(counter.value).toBe(0);
});

test("a failed mutation propagates and is never replayed", async () => {
  const counter = new (withDeploymentReadiness(Counter))(
    {} as any,
    { CF_VERSION_METADATA: { id: "new" } } as any,
  );
  const stub = deploymentReadyStub(counter, {
    version: "new",
    object: "PROJECT:prj_test",
    timeoutMs: 100,
    intervalMs: 1,
  });
  await expect(stub.failAfterIncrement()).rejects.toThrow("mutation failed");
  expect(counter.value).toBe(1);
});

test("a version that never arrives fails with the object and both versions", async () => {
  const counter = new (withDeploymentReadiness(Counter))(
    {} as any,
    { CF_VERSION_METADATA: { id: "old" } } as any,
  );
  const stub = deploymentReadyStub(counter, {
    version: "new",
    object: "PROJECT:prj_test",
    timeoutMs: 2,
    intervalMs: 1,
  });
  await expect(stub.increment(3)).rejects.toThrow(/PROJECT:prj_test: expected new, got old/);
  expect(counter.value).toBe(0);
});

test("a stalled version read is bounded without starting the operation", async () => {
  let calls = 0;
  const stub = deploymentReadyStub(
    {
      deploymentVersion: () => new Promise<string>(() => {}),
      callAtVersion: async () => {
        calls++;
        return { ready: true, value: 1 };
      },
      increment() {
        throw new Error("raw method must not be called");
      },
    },
    { version: "new", object: "STREAM:prj_stalled", timeoutMs: 5, intervalMs: 1 },
  );
  await expect(stub.increment()).rejects.toThrow(/STREAM:prj_stalled: expected new, got unknown/);
  expect(calls).toBe(0);
});

test("unrelated probe errors propagate without a retry", async () => {
  const failure = new Error("network failure");
  let probes = 0;
  const stub = deploymentReadyStub(
    {
      async deploymentVersion() {
        probes++;
        throw failure;
      },
      increment() {
        throw new Error("raw method must not be called");
      },
    },
    { version: "new", object: "STREAM:prj_failed", timeoutMs: 100, intervalMs: 1 },
  );
  await expect(stub.increment()).rejects.toBe(failure);
  expect(probes).toBe(1);
});

test("awaiting a native RPC property reads the guarded getter, preserving its returned handle", async () => {
  const counter = new (withDeploymentReadiness(Counter))(
    {} as any,
    { CF_VERSION_METADATA: { id: "new" } } as any,
  );
  const nativeProperty = Object.assign(
    () => {
      throw new Error("getter is not a method");
    },
    {
      then(resolve: any, reject: any) {
        return Promise.resolve(counter.processor).then(resolve, reject);
      },
    },
  );
  const raw = {
    deploymentVersion: () => counter.deploymentVersion(),
    callAtVersion: (version: string, method: string, args: unknown[] | null) =>
      (counter as any).callAtVersion(version, method, args),
    processor: nativeProperty,
  };
  const stub = deploymentReadyStub(raw, {
    version: "new",
    object: "PROJECT:prj_getter",
    timeoutMs: 100,
    intervalMs: 1,
  });
  const remote: any = stub;
  const processor = await remote.processor;
  expect(await processor.increment(4)).toBe(4);
  expect(counter.value).toBe(4);
});

test("fetch preserves RequestInfo/init and refuses the old version before its handler", async () => {
  const counter = new (withDeploymentReadiness(Counter))(
    {} as any,
    { CF_VERSION_METADATA: { id: "new" } } as any,
  );
  const stub = deploymentReadyStub(counter, {
    version: "new",
    object: "PROJECT:prj_fetch",
    timeoutMs: 100,
    intervalMs: 1,
  });
  // The namespace fetch API accepts URL + init; the DO handler receives Request.
  const remote: any = stub;
  const response = await remote.fetch("https://os.iterate.com/", { method: "POST", body: "input" });
  expect(await response.json()).toEqual({ method: "POST", body: "input", internalHeader: null });
  const rejected = await counter.fetch(
    new Request("https://os.iterate.com/", { headers: { "x-iterate-do-expected-version": "old" } }),
  );
  expect(rejected.status).toBe(503);
  expect(counter.value).toBe(1);
});

test("an application 503 cannot forge a readiness response and trigger a replay", async () => {
  const counter = new (withDeploymentReadiness(Counter))(
    {} as any,
    { CF_VERSION_METADATA: { id: "new" } } as any,
  );
  const remote: any = deploymentReadyStub(counter, {
    version: "new",
    object: "PROJECT:prj_fetch",
    timeoutMs: 100,
    intervalMs: 1,
  });
  const response = await remote.fetch("https://os.iterate.com/forged");
  expect(response.status).toBe(503);
  expect(response.headers.get("x-iterate-do-mismatching-version")).toBeNull();
  expect(counter.value).toBe(1);
});

test("disposing a call during readiness prevents it from starting later", async () => {
  let resume: (version: string) => void = () => {};
  let calls = 0;
  const remote: any = deploymentReadyStub(
    {
      deploymentVersion: () =>
        new Promise<string>((resolve) => {
          resume = resolve;
        }),
      callAtVersion: async () => {
        calls++;
        return { ready: true, value: 1 };
      },
      increment() {
        throw new Error("raw method must not run");
      },
    },
    { version: "new", object: "STREAM:prj_cancelled", timeoutMs: 100, intervalMs: 1 },
  );
  const call = remote.increment();
  call[Symbol.dispose]();
  resume("new");
  await expect(call).rejects.toThrow("disposed");
  expect(calls).toBe(0);
});

class Counter extends DurableObject<any> {
  value = 0;
  async deploymentVersion() {
    return this.env.CF_VERSION_METADATA.id;
  }
  get processor() {
    return { increment: (amount: number) => this.increment(amount) };
  }
  async fetch(request: Request) {
    this.value++;
    if (new URL(request.url).pathname === "/forged")
      return new Response(null, {
        status: 503,
        headers: { "x-iterate-do-mismatching-version": "forged" },
      });
    return Response.json({
      method: request.method,
      body: await request.text(),
      internalHeader: request.headers.get("x-iterate-do-expected-version"),
    });
  }
  increment(amount: number) {
    this.value += amount;
    return this.value;
  }
  failAfterIncrement() {
    this.value++;
    throw new Error("mutation failed");
  }
}
