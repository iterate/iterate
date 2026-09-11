import { WorkerEntrypoint } from "cloudflare:workers";
import { createWorker, hasDependencies, InMemoryFileSystem } from "@cloudflare/worker-bundler";
import { z } from "zod";
import { BuildOptions, BuiltCode, type BuildResult } from "./build.ts";
import { sha256 } from "./encoding.ts";
import { canonical } from "./signatures.ts";

const RequestInput = z.strictObject({
  files: z.record(z.string(), z.string()),
  options: BuildOptions,
});
const BuildFailure = z.object({ errors: z.array(z.object({ text: z.string() })).min(1) });

/** Stateless compiler with a disposable data cache; no project, ITX, or user-code execution. */
export default class Bundler extends WorkerEntrypoint<{
  BUILD_CACHE: KVNamespace;
  VERSION: { id: string };
}> {
  async build(value: z.infer<typeof RequestInput>): Promise<BuildResult> {
    const input = RequestInput.parse(value);
    if (hasDependencies(new InMemoryFileSystem(input.files)))
      return {
        status: "rejected",
        diagnostics: [
          "Bundle inputs must contain resolved dependency bytes; registry installation is not enabled.",
        ],
      };
    if (!Object.hasOwn(input.files, input.options.entryPoint))
      return {
        status: "rejected",
        diagnostics: [`Entry point ${input.options.entryPoint} is not in this revision.`],
      };
    // VERSION identifies deployed code, exact dependency/patch bytes, cache schema and defaults.
    const key = await sha256(canonical({ version: this.env.VERSION.id, input }));
    const cached = await this.env.BUILD_CACHE.get(key, "json");
    if (cached)
      return { status: "built", code: BuiltCode.parse(cached), diagnostics: [], key, cache: "hit" };
    let output;
    try {
      output = await createWorker({
        files: input.files,
        ...input.options,
        // Source diagnostics are returned below; esbuild must not also log them as runtime defects.
        __dangerouslyUseEsBuildPluginsDoNotUseOrYouWillBeFired: [
          {
            name: "structured-diagnostics",
            setup(build: { initialOptions: { logLevel?: string } }) {
              build.initialOptions.logLevel = "silent";
            },
          },
        ],
      });
    } catch (error) {
      const failure = BuildFailure.safeParse(error);
      if (!failure.success) throw error; // Compiler crashes are defects, not source diagnostics.
      return { status: "rejected", diagnostics: failure.data.errors.map((error) => error.text) };
    }
    if (output.warnings?.length) return { status: "rejected", diagnostics: output.warnings };
    const code = BuiltCode.parse({
      mainModule: output.mainModule,
      modules: output.modules,
      compatibilityDate: output.wranglerConfig?.compatibilityDate ?? "2026-09-04",
      compatibilityFlags: output.wranglerConfig?.compatibilityFlags ?? [
        "no_nodejs_compat",
        "no_nodejs_compat_v2",
      ],
    });
    await this.env.BUILD_CACHE.put(key, JSON.stringify(code), { expirationTtl: 86400 });
    return { status: "built", code, diagnostics: [], key, cache: "miss" };
  }
  override fetch() {
    return new Response("RPC only", { status: 404 });
  }
}
