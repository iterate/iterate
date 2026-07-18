import { expect, test } from "vitest";
import { ITERATE_LIVE_STATE_VIRTUAL_MODULE } from "./iterate-live-state-virtual-module.generated.ts";

test("the embedded iterate/live-state runtime is loader-ready plain JavaScript", async () => {
  const esbuild = await import("esbuild");
  await expect(
    esbuild.transform(ITERATE_LIVE_STATE_VIRTUAL_MODULE, { format: "esm", loader: "js" }),
  ).resolves.toBeDefined();

  expect(ITERATE_LIVE_STATE_VIRTUAL_MODULE).toContain("LiveState");
  expect(ITERATE_LIVE_STATE_VIRTUAL_MODULE).toContain("LiveStateRpcTarget");
  expect(ITERATE_LIVE_STATE_VIRTUAL_MODULE).toContain("createLiveStateStore");
  expect(ITERATE_LIVE_STATE_VIRTUAL_MODULE).toContain('from "@iterate-com/capnweb"');
  expect(ITERATE_LIVE_STATE_VIRTUAL_MODULE).not.toContain("import type");
});
