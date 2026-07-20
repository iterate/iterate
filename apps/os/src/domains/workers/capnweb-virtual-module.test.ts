import { expect, test } from "vitest";
import { CAPNWEB_VIRTUAL_MODULE } from "./capnweb-virtual-module.generated.ts";

test("the embedded Cap'n Web runtime is loader-ready JavaScript", async () => {
  const esbuild = await import("esbuild");
  await expect(
    esbuild.transform(CAPNWEB_VIRTUAL_MODULE, { format: "esm", loader: "js" }),
  ).resolves.toBeDefined();
  expect(CAPNWEB_VIRTUAL_MODULE).toContain("RpcTarget");
  expect(
    [...CAPNWEB_VIRTUAL_MODULE.matchAll(/from\s+"([^"]+)"/g)].map((match) => match[1]),
  ).toEqual(["cloudflare:workers"]);
});
