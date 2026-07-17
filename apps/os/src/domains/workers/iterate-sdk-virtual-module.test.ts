import { expect, test, vi } from "vitest";
import { ITERATE_SDK_VIRTUAL_MODULE } from "./iterate-sdk-virtual-module.generated.ts";

test("the embedded iterate/sdk runtime is loader-ready plain JavaScript", async () => {
  // Virtual modules load under esbuild's "js" loader (see the bundler's
  // virtual-modules plugin), so any TS syntax surviving the codegen transform
  // would fail EVERY dynamic worker build. Round-tripping the embed through
  // esbuild's js loader is the same parse the real build performs.
  const esbuild = await import("esbuild");
  await expect(
    esbuild.transform(ITERATE_SDK_VIRTUAL_MODULE, { format: "esm", loader: "js" }),
  ).resolves.toBeDefined();

  // The runtime surface project workers and apps extend, with its one
  // platform dependency left external for workerd to resolve.
  expect(ITERATE_SDK_VIRTUAL_MODULE).toContain("class IterateWorkerEntrypoint");
  expect(ITERATE_SDK_VIRTUAL_MODULE).toContain("class IterateDurableObject");
  expect(ITERATE_SDK_VIRTUAL_MODULE).toContain("processEventBatch");
  expect(ITERATE_SDK_VIRTUAL_MODULE).toContain("invokeCapability");
  expect(ITERATE_SDK_VIRTUAL_MODULE).toContain("x-iterate-worker-dispatch");
  expect(ITERATE_SDK_VIRTUAL_MODULE).toContain('from "cloudflare:workers"');
  expect(ITERATE_SDK_VIRTUAL_MODULE).not.toContain("import type");
  expect(ITERATE_SDK_VIRTUAL_MODULE).not.toContain("export type");
});

test("project auth is a body-safe partial fetch in the embedded worker runtime", async () => {
  const { IterateWorkerEntrypoint } = await loadEmbeddedSdk();
  const requests: (Request | ProjectAuthMetadata)[] = [];
  const dispose = vi.fn();
  const remoteAuth = {
    async fetch(request: Request | ProjectAuthMetadata): Promise<Response | null> {
      requests.push(request);
      if (!(request instanceof Request)) return null;
      expect(await request.text()).toBe("callback-token");
      return new Response("auth-owned");
    },
    get: vi.fn(() => remoteAuth),
  };
  const describe = vi.fn(async function () {
    return { projectId: "prj_demo" };
  });
  const remoteItx = {
    __describe: describe,
    auth: remoteAuth,
    [Symbol.dispose]: dispose,
  };
  const rawBinding = {
    fetch: vi.fn(),
    get: vi.fn(async () => remoteItx),
  };
  const worker = new IterateWorkerEntrypoint({}, { ITX: rawBinding }) as {
    env: {
      ITX: {
        get(): Promise<{
          __describe(): Promise<{ projectId: string }>;
          auth: TestProjectAuth;
          [Symbol.dispose](): void;
        }>;
      };
    };
  };
  const itx = await worker.env.ITX.get();

  const appRequest = new Request("https://internal--demo.iterate.app/echo", {
    body: "app-owned-body",
    headers: { cookie: "iterate-project-auth=signed-token" },
    method: "POST",
  });
  await expect(itx.auth.get({ policy: "project-member" }).fetch(appRequest)).resolves.toBeNull();
  expect(requests[0]).not.toBeInstanceOf(Request);
  expect(requests[0]).toMatchObject({
    method: "POST",
    url: appRequest.url,
  });
  expect(requests[0]).not.toHaveProperty("body");
  expect(new Headers((requests[0] as ProjectAuthMetadata).headers).get("cookie")).toBe(
    "iterate-project-auth=signed-token",
  );
  expect(appRequest.bodyUsed).toBe(false);
  await expect(appRequest.text()).resolves.toBe("app-owned-body");

  const callback = new Request("https://internal--demo.iterate.app/_iterate/auth/callback", {
    body: "callback-token",
    method: "POST",
  });
  const callbackResponse = await itx.auth.get({ policy: "project-member" }).fetch(callback);
  expect(await callbackResponse?.text()).toBe("auth-owned");
  expect(requests[1]).toBe(callback);
  expect(callback.bodyUsed).toBe(true);

  await expect(itx.__describe()).resolves.toEqual({ projectId: "prj_demo" });
  expect(describe.mock.instances[0]).toBe(remoteItx);

  itx[Symbol.dispose]();
  expect(dispose).toHaveBeenCalledOnce();
});

type ProjectAuthMetadata = {
  headers: [string, string][];
  method: string;
  url: string;
};

type TestProjectAuth = {
  get(policy: { policy: "project-member" }): TestProjectAuth;
  fetch(request: Request): Promise<Response | null>;
};

async function loadEmbeddedSdk(): Promise<{
  IterateWorkerEntrypoint: new (ctx: unknown, env: unknown) => unknown;
}> {
  const cloudflareImport = 'import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";';
  const testRuntime = `
    class WorkerEntrypoint {
      constructor(ctx, env) { this.ctx = ctx; this.env = env; }
    }
    class DurableObject {
      constructor(ctx, env) { this.ctx = ctx; this.env = env; }
    }
  `;
  const source = ITERATE_SDK_VIRTUAL_MODULE.replace(cloudflareImport, testRuntime);
  expect(source).not.toBe(ITERATE_SDK_VIRTUAL_MODULE);
  const url = `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
  return (await import(url)) as {
    IterateWorkerEntrypoint: new (ctx: unknown, env: unknown) => unknown;
  };
}
