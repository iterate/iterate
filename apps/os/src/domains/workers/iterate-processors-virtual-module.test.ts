import { expect, test } from "vitest";
import { ITERATE_PROCESSORS_CLOUDFLARE_VIRTUAL_MODULE } from "./iterate-processors-cloudflare-virtual-module.generated.ts";
import { ITERATE_PROCESSORS_VIRTUAL_MODULE } from "./iterate-processors-virtual-module.generated.ts";

/** Every module specifier imported by a bundle (deduped, sorted). */
function externals(code: string): string[] {
  return [...new Set([...code.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]))]
    .filter((specifier) => !specifier.startsWith("."))
    .sort();
}

test("the embedded iterate/processors runtime is loader-ready plain JavaScript", async () => {
  // Virtual modules load under esbuild's "js" loader (see the bundler's
  // virtual-modules plugin), so any TS syntax surviving the codegen bundle
  // would fail EVERY dynamic worker build that imports iterate/processors.
  const esbuild = await import("esbuild");
  await expect(
    esbuild.transform(ITERATE_PROCESSORS_VIRTUAL_MODULE, { format: "esm", loader: "js" }),
  ).resolves.toBeDefined();

  // The PURE machinery a worker-authored processor needs (see the config-repo
  // template's guestbook). The hosting layer (registry + DO durability) is
  // deliberately absent — it ships as iterate/processors/cloudflare below.
  expect(ITERATE_PROCESSORS_VIRTUAL_MODULE).toContain("defineProcessorContract");
  expect(ITERATE_PROCESSORS_VIRTUAL_MODULE).toContain("StreamProcessor");
  expect(ITERATE_PROCESSORS_VIRTUAL_MODULE).not.toContain("createStreamProcessorRegistry");

  // Real bundle; deliberate externals only: zod (the worker's own installed
  // copy, so worker-authored contract schemas and the machinery share one
  // instance) and cloudflare:workers — which OUR pure machinery never
  // imports (that is the point of the entry split); it enters here solely as
  // capnweb's workerd build, selected by the bundle's workerd condition. In
  // node the same entry resolves capnweb's node build and the graph is
  // cloudflare-free (the e2e suite imports template processor modules with no
  // shim).
  expect(externals(ITERATE_PROCESSORS_VIRTUAL_MODULE)).toEqual(["cloudflare:workers", "zod"]);
});

test("the embedded iterate/processors/cloudflare hosting layer shares the pure module", async () => {
  const esbuild = await import("esbuild");
  await expect(
    esbuild.transform(ITERATE_PROCESSORS_CLOUDFLARE_VIRTUAL_MODULE, {
      format: "esm",
      loader: "js",
    }),
  ).resolves.toBeDefined();

  expect(ITERATE_PROCESSORS_CLOUDFLARE_VIRTUAL_MODULE).toContain("createStreamProcessorRegistry");
  expect(ITERATE_PROCESSORS_CLOUDFLARE_VIRTUAL_MODULE).toContain("durableObjectRecovery");

  // The pure machinery must arrive via the `iterate/processors` virtual
  // module, never a second bundled copy: the registry's runner reaches
  // private fields of user processor instances (StreamProcessor.runnerDriver),
  // and private-field access requires the instance to be branded by the SAME
  // class object — a duplicate StreamProcessor would throw on registration.
  expect(externals(ITERATE_PROCESSORS_CLOUDFLARE_VIRTUAL_MODULE)).toEqual([
    "cloudflare:workers",
    "iterate/processors",
  ]);
});
