import { expect, test } from "vitest";
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
  expect(ITERATE_SDK_VIRTUAL_MODULE).toContain("IterateWorkerEntrypoint");
  expect(ITERATE_SDK_VIRTUAL_MODULE).toContain("IterateDurableObject");
  expect(ITERATE_SDK_VIRTUAL_MODULE).toContain("StreamProcessor");
  expect(ITERATE_SDK_VIRTUAL_MODULE).toContain("createStreamProcessorHost");
  expect(ITERATE_SDK_VIRTUAL_MODULE).toContain("defineProcessorContract");
  expect(ITERATE_SDK_VIRTUAL_MODULE).toContain("processEventBatch");
  expect(ITERATE_SDK_VIRTUAL_MODULE).toContain("invokeCapability");
  expect(ITERATE_SDK_VIRTUAL_MODULE).toContain("x-iterate-worker-dispatch");
  expect(ITERATE_SDK_VIRTUAL_MODULE).toContain('"cloudflare:workers"');
  expect(ITERATE_SDK_VIRTUAL_MODULE).not.toContain("import type");
  expect(ITERATE_SDK_VIRTUAL_MODULE).not.toContain("export type");
});
