import { describe, expect, it } from "vitest";
import {
  collectRecipeOutputs,
  collectViteRecipeOutputs,
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
    expect(withPackage.commands).toHaveLength(2);
    expect(withPackage.commands[1]!.command).toContain("WRANGLER_SEND_METRICS=false wrangler");
    // The install step is nub-first with an npm fallback; BOTH lanes must
    // keep the no-lifecycle-scripts security property and skip dev deps.
    const install = withPackage.commands[0]!.command;
    expect(install).toContain("nub install --ignore-scripts --prod");
    expect(install).toContain("|| npm install --ignore-scripts");
    expect(install).toContain("--omit=dev");

    const withoutPackage = workerBuildRecipe({
      files: { "worker.ts": "export default {};" },
      options: { entryPoint: "worker.ts" },
    });
    expect(withoutPackage.commands).toHaveLength(1);
    expect(withoutPackage.commands[0]!.command).toContain("wrangler deploy --dry-run");
  });

  it("vite pipeline: the app's own install+build, collected as wrapped dist modules", () => {
    const recipe = workerBuildRecipe({
      files: {
        "apps/tanstack/package.json": JSON.stringify({ scripts: { build: "vite build" } }),
        "apps/tanstack/vite.config.ts": "export default {};",
        "elsewhere.ts": "export {};",
      },
      options: { pipeline: "vite", rootDir: "apps/tanstack" },
    });
    expect(recipe.pipeline).toBe("vite");
    // rootDir re-roots the map and drops everything outside it.
    expect(Object.keys(recipe.files).sort()).toEqual(["package.json", "vite.config.ts"]);
    expect(recipe.commands).toHaveLength(2);
    // devDependencies install (no --prod/--omit=dev — vite lives there), and
    // BOTH install lanes keep the no-lifecycle-scripts property; the build
    // step is where project code deliberately runs.
    expect(recipe.commands[0]!.command).toContain("nub install --ignore-scripts --prefer-offline");
    expect(recipe.commands[0]!.command).not.toContain("--prod");
    expect(recipe.commands[0]!.command).toContain("|| npm install --ignore-scripts");
    expect(recipe.commands[0]!.command).not.toContain("--omit=dev");
    expect(recipe.commands[1]!.command).toBe("npm run build");

    const collected = collectViteRecipeOutputs({
      "dist/server/index.js": "export default { fetch() {} }; export class TanstackTodos {}",
      "dist/server/assets/chunk-abc.js": "export {};",
      "dist/server/assets/styles-server.css": "body { color: red; }",
      // Vite may emit server-only support files that this text-module loader
      // neither imports nor serves. They must retain the old skip behavior;
      // trying to decode one as a browser text asset breaks otherwise-valid
      // SSR builds.
      "dist/server/assets/renderer.wasm": "\0asm-binary-placeholder",
      "dist/server/wrangler.json": "{}",
      "dist/client/assets/index-abc.js": "console.log(1)",
      "dist/client/.assetsignore": "",
    });
    expect(collected.mainModule).toBe(".iterate-build.entry.js");
    expect(Object.keys(collected.modules).sort()).toEqual([
      ".iterate-build.assets.js",
      ".iterate-build.entry.js",
      "dist/server/assets/chunk-abc.js",
      "dist/server/index.js",
    ]);
    // The wrapper serves the client asset and re-exports the server entry's
    // names (Durable Object classes ride through for stateful hosting).
    expect(collected.modules[".iterate-build.entry.js"]).toContain(
      'export * from "./dist/server/index.js"',
    );
    expect(collected.modules[".iterate-build.assets.js"]).toContain("/assets/index-abc.js");
    // TanStack's SSR manifest can reference CSS emitted only under
    // dist/server. It is still a browser asset and must be served at the
    // URL embedded in the rendered document.
    expect(collected.modules[".iterate-build.assets.js"]).toContain('"/assets/styles-server.css"');
    expect(collected.modules[".iterate-build.assets.js"]).not.toContain("renderer.wasm");

    expect(() => collectViteRecipeOutputs({ "dist/server/other.js": "" })).toThrow(
      /did not produce "dist\/server\/index.js"/,
    );
    expect(() =>
      collectViteRecipeOutputs({
        "dist/server/index.js": "",
        "dist/client/logo.png": "binary",
      }),
    ).toThrow(/not a text type/);
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
    expect(recipe.files[".iterate-build.entry.ts"]).toContain(".default ?? {}");
    expect(recipe.mainModule).toBe(".iterate-build.entry.js");
  });

  it("defaults the entry to worker.ts and rejects a missing entry", () => {
    const recipe = workerBuildRecipe({ files: templateFiles, options: {} });
    expect(recipe.files[".iterate-build.entry.ts"]).toContain('export * from "./worker.ts"');
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
      ".iterate-build.entry.js": "bundled",
      ".iterate-build.entry.js.map": "{}",
      "README.md": "wrangler notes",
    });
    expect(collected).toEqual({
      mainModule: ".iterate-build.entry.js",
      modules: { ".iterate-build.entry.js": "bundled" },
    });
  });

  it("refuses non-text output rather than storing it corrupted", () => {
    expect(() =>
      collectRecipeOutputs(recipe, { ".iterate-build.entry.js": "bundled", "data.wasm": "\0\0" }),
    ).toThrow(/unsupported format/);
  });

  it("refuses output missing the entry module", () => {
    expect(() => collectRecipeOutputs(recipe, { "other.js": "x" })).toThrow(
      /did not produce the entry module/,
    );
  });
});
