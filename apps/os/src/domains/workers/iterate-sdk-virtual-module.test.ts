import { Buffer } from "node:buffer";
import { expect, test } from "vitest";
import { ITERATE_SDK_VIRTUAL_MODULE } from "./iterate-sdk-virtual-module.generated.ts";

type EmbeddedSdk = {
  IterateDurableObject: new (...args: unknown[]) => EventBatchReceiver;
  IterateWorkerEntrypoint: new (...args: unknown[]) => EventBatchReceiver;
};

type EventBatchReceiver = {
  processEventBatch(batch: { events: unknown[] }): Promise<void>;
};

async function loadEmbeddedSdk(): Promise<EmbeddedSdk> {
  const esbuild = await import("esbuild");
  const result = await esbuild.build({
    bundle: true,
    format: "esm",
    plugins: [
      {
        name: "cloudflare-workers-test-stub",
        setup(build) {
          build.onResolve({ filter: /^cloudflare:workers$/ }, () => ({
            namespace: "cloudflare-workers-test-stub",
            path: "cloudflare:workers",
          }));
          build.onLoad({ filter: /.*/, namespace: "cloudflare-workers-test-stub" }, () => ({
            contents: "export class DurableObject {}\nexport class WorkerEntrypoint {}",
            loader: "js",
          }));
        },
      },
    ],
    stdin: {
      contents: ITERATE_SDK_VIRTUAL_MODULE,
      loader: "js",
      resolveDir: import.meta.dirname,
    },
    write: false,
  });
  const source = result.outputFiles[0]!.text;
  return (await import(
    `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`
  )) as EmbeddedSdk;
}

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

test.each(["IterateWorkerEntrypoint", "IterateDurableObject"] as const)(
  "%s processes synchronous handlers without yielding between events",
  async (className) => {
    const sdk = await loadEmbeddedSdk();
    const seen: unknown[] = [];
    const receiver = Object.assign(new sdk[className](), {
      processEvent(event: unknown): void {
        seen.push(event);
      },
    });
    const events = [{ index: 0 }, { index: 1 }, { index: 2 }];

    const completion = receiver.processEventBatch({ events });

    expect(seen).toEqual(events);
    await completion;
  },
);

test.each(["IterateWorkerEntrypoint", "IterateDurableObject"] as const)(
  "%s awaits asynchronous handlers in order",
  async (className) => {
    const sdk = await loadEmbeddedSdk();
    const seen: unknown[] = [];
    let releaseFirst!: () => void;
    const firstCompletion = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const receiver = Object.assign(new sdk[className](), {
      processEvent(event: unknown): void | Promise<void> {
        seen.push(event);
        if (seen.length === 1) return firstCompletion;
      },
    });
    const events = [{ index: 0 }, { index: 1 }, { index: 2 }];

    const completion = receiver.processEventBatch({ events });
    expect(seen).toEqual(events.slice(0, 1));

    releaseFirst();
    await completion;
    expect(seen).toEqual(events);
  },
);

test.each(["IterateWorkerEntrypoint", "IterateDurableObject"] as const)(
  "%s propagates handler failures and stops the batch",
  async (className) => {
    const sdk = await loadEmbeddedSdk();
    const seen: unknown[] = [];
    const failure = new Error("process event failed");
    const receiver = Object.assign(new sdk[className](), {
      processEvent(event: unknown): void | Promise<void> {
        seen.push(event);
        if (seen.length === 2) return Promise.reject(failure);
      },
    });
    const events = [{ index: 0 }, { index: 1 }, { index: 2 }];

    await expect(receiver.processEventBatch({ events })).rejects.toBe(failure);
    expect(seen).toEqual(events.slice(0, 2));
  },
);
