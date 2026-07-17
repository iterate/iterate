import { describe, expect, it } from "vitest";
import {
  collectRecipeOutputs,
  WORKER_COMPATIBILITY_DATE,
  WORKER_COMPATIBILITY_FLAGS,
  workerBuildRecipe,
} from "./build-recipe.ts";

const templateFiles = {
  "worker.ts": "export default {};",
  "lib/helper.ts": "export const x = 1;",
  "package.json": JSON.stringify({ dependencies: {} }),
};

describe("workerBuildRecipe", () => {
  it("generates the wrangler config with OS-owned compatibility and the entry", () => {
    const recipe = workerBuildRecipe({
      files: templateFiles,
      options: { entryPoint: "worker.ts" },
    });
    const config = JSON.parse(recipe.files[".iterate-build.wrangler.jsonc"]!) as Record<
      string,
      unknown
    >;
    expect(config.main).toBe(".iterate-build.entry.ts");
    // OS owns dynamic-worker compatibility — never read from the source's own
    // wrangler config (a second compat channel would bypass the build key).
    expect(config.compatibility_date).toBe(WORKER_COMPATIBILITY_DATE);
    expect(config.compatibility_flags).toEqual(WORKER_COMPATIBILITY_FLAGS);
    expect(recipe.mainModule).toBe(".iterate-build.entry.js");
    expect(recipe.outputDir).toBe(".iterate-build.out");
  });

  it("installs only when the source has a package.json, always bundles via wrangler dry-run", () => {
    const withPackage = workerBuildRecipe({
      files: templateFiles,
      options: { entryPoint: "worker.ts" },
    });
    expect(withPackage.commands.map((step) => step.command.split(" ")[0])).toEqual([
      "npm",
      "WRANGLER_SEND_METRICS=false",
    ]);
    expect(withPackage.commands[0]!.command).toContain("--ignore-scripts");
    expect(withPackage.commands[0]!.command).toContain("--omit=dev");

    const withoutPackage = workerBuildRecipe({
      files: { "worker.ts": "export default {};" },
      options: { entryPoint: "worker.ts" },
    });
    expect(withoutPackage.commands).toHaveLength(1);
    expect(withoutPackage.commands[0]!.command).toContain("wrangler deploy --dry-run");
  });

  it("materializes virtual modules as files aliased in the wrangler config", () => {
    const recipe = workerBuildRecipe({
      files: { "worker.ts": 'import "iterate/sdk";' },
      options: {
        entryPoint: "worker.ts",
        virtualModules: { "iterate/sdk": "export const s = 1;" },
      },
    });
    const config = JSON.parse(recipe.files[".iterate-build.wrangler.jsonc"]!) as {
      alias: Record<string, string>;
    };
    const aliasTarget = config.alias["iterate/sdk"]!;
    expect(aliasTarget).toMatch(/^\.\/\.iterate-build\.virtual\//);
    expect(recipe.files[aliasTarget.slice(2)]).toBe("export const s = 1;");
  });

  it("routes every build through the entry shim so wrangler always sees module format", () => {
    // Named-exports-only entries (a WorkerEntrypoint or Durable Object class
    // exported by name) would otherwise be inferred as service-worker format,
    // which rejects cloudflare:workers imports. Unconditional — syntactic
    // "has a default export" detection misclassifies strings and comments,
    // and the shim is correct either way.
    const recipe = workerBuildRecipe({
      files: {
        "swr/probe.ts":
          'import { WorkerEntrypoint } from "cloudflare:workers";\nexport class Api extends WorkerEntrypoint {}',
      },
      options: { entryPoint: "swr/probe.ts" },
    });
    expect(recipe.files[".iterate-build.entry.ts"]).toContain('export * from "./swr/probe.ts"');
    expect(recipe.files[".iterate-build.entry.ts"]).toContain("entry.default ?? {}");
    expect(recipe.mainModule).toBe(".iterate-build.entry.js");
  });

  it("defaults the entry to worker.ts and rejects a missing entry", () => {
    expect(workerBuildRecipe({ files: templateFiles, options: {} }).mainModule).toBe("worker.js");
    expect(() =>
      workerBuildRecipe({ files: templateFiles, options: { entryPoint: "missing.ts" } }),
    ).toThrow(/not in the worker source files/);
  });

  it("rejects unsafe and reserved source paths — they are written to disk by the runners", () => {
    for (const name of [
      "../escape.ts",
      "/absolute.ts",
      "a/../../b.ts",
      "a\\b.ts",
      "",
      ".iterate-build.wrangler.jsonc",
      ".iterate-build.out/worker.js",
    ]) {
      expect(
        () =>
          workerBuildRecipe({
            files: { "worker.ts": "", [name]: "" },
            options: { entryPoint: "worker.ts" },
          }),
        name,
      ).toThrow();
    }
  });

  it("rejects bundle: false — loader-ready sources never reach the pipeline", () => {
    expect(() => workerBuildRecipe({ files: templateFiles, options: { bundle: false } })).toThrow(
      /loader-ready/,
    );
  });
});

describe("collectRecipeOutputs", () => {
  const recipe = workerBuildRecipe({ files: templateFiles, options: { entryPoint: "worker.ts" } });

  it("keeps JS modules, drops sourcemaps and wrangler's README", () => {
    const collected = collectRecipeOutputs(recipe, {
      "worker.js": "bundled",
      "worker.js.map": "{}",
      "README.md": "wrangler notes",
    });
    expect(collected).toEqual({ mainModule: "worker.js", modules: { "worker.js": "bundled" } });
  });

  it("refuses non-text output rather than storing it corrupted", () => {
    expect(() =>
      collectRecipeOutputs(recipe, { "worker.js": "bundled", "data.wasm": "\0\0" }),
    ).toThrow(/unsupported format/);
  });

  it("refuses output missing the entry module", () => {
    expect(() => collectRecipeOutputs(recipe, { "other.js": "x" })).toThrow(
      /did not produce the entry module/,
    );
  });
});
