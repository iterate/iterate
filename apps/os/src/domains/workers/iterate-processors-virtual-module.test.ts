import { expect, test } from "vitest";
import { ITERATE_PROCESSORS_VIRTUAL_MODULE } from "./iterate-processors-virtual-module.generated.ts";

test("the embedded iterate/processors runtime is loader-ready plain JavaScript", async () => {
  // Virtual modules load under esbuild's "js" loader (see the bundler's
  // virtual-modules plugin), so any TS syntax surviving the codegen bundle
  // would fail EVERY dynamic worker build that imports iterate/processors.
  const esbuild = await import("esbuild");
  await expect(
    esbuild.transform(ITERATE_PROCESSORS_VIRTUAL_MODULE, { format: "esm", loader: "js" }),
  ).resolves.toBeDefined();

  // The machinery a worker-hosted processor needs (see the config-repo
  // template's guestbook for the full shape).
  expect(ITERATE_PROCESSORS_VIRTUAL_MODULE).toContain("defineProcessorContract");
  expect(ITERATE_PROCESSORS_VIRTUAL_MODULE).toContain("StreamProcessor");
  expect(ITERATE_PROCESSORS_VIRTUAL_MODULE).toContain("createStreamProcessorRegistry");

  // The embed is a real bundle (capnweb and the live-state engine are
  // inlined); its ONLY imports are the two deliberate externals — zod (the
  // worker's own installed copy, so worker-authored contract schemas and the
  // machinery share one instance) and cloudflare:workers (workerd's).
  const imports = ITERATE_PROCESSORS_VIRTUAL_MODULE.match(/^import .*$/gm) ?? [];
  const externals = new Set(
    imports.map((line) => /from "([^"]+)"/.exec(line)?.[1]).filter(Boolean),
  );
  expect([...externals].sort()).toEqual(["cloudflare:workers", "zod"]);
});
