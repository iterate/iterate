import { expect, test } from "vitest";
import { ITERATE_APP_VIRTUAL_MODULE } from "./iterate-app-virtual-module.generated.ts";

test("the embedded iterate/app runtime is loader-ready plain JavaScript", async () => {
  const esbuild = await import("esbuild");
  await expect(
    esbuild.transform(ITERATE_APP_VIRTUAL_MODULE, { format: "esm", loader: "js" }),
  ).resolves.toBeDefined();

  expect(ITERATE_APP_VIRTUAL_MODULE).toContain("LiveStateRpcTarget");
  expect(ITERATE_APP_VIRTUAL_MODULE).toContain('from "@iterate-com/capnweb"');
  expect(ITERATE_APP_VIRTUAL_MODULE).not.toContain("import type");
});
