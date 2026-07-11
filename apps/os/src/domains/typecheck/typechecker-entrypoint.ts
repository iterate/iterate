import { WorkerEntrypoint } from "cloudflare:workers";
import { z } from "zod";
import { createCompiler, type Compiler } from "tswasm";
// The typescript-go compiler as a wasm module (~30MB raw, ~7MB gzip) — the
// whole reason this is a sidecar worker: the product script stays lean, the
// same way the builder quarantines esbuild-wasm.
import typescriptWasm from "tswasm/tswasm.wasm";
import { runTypecheck, type TypecheckDiagnostic } from "./run-typecheck.ts";

/** The whole input is inert data: a virtual file map. Nothing here grants
 * authority — the checker reads public npm type metadata at most. */
const CheckInput = z.object({
  files: z.record(z.string(), z.string()),
});

/** One wasm instantiation per isolate, shared across requests. A failed
 * instantiation is NOT cached: caching the rejection would poison every
 * later check until isolate death, so the next check retries. */
let compilerPromise: Promise<Compiler> | undefined;
function compiler(): Promise<Compiler> {
  const promise = (compilerPromise ??= createCompiler({
    wasm: typescriptWasm as WebAssembly.Module,
  }));
  promise.catch(() => {
    if (compilerPromise === promise) compilerPromise = undefined;
  });
  return promise;
}

/**
 * The typechecker worker's entrypoint: a pure function worker (files in,
 * diagnostics out) mirroring the builder sidecar. The os worker calls
 * `env.TYPECHECKER.check(...)` for provide-time capability-types validation
 * and the `itx.docs.typecheck` door; a compiler upgrade redeploys one worker.
 */
export class TypecheckerEntrypoint extends WorkerEntrypoint {
  /** The typechecker serves no HTTP; everything arrives over RPC. */
  override fetch(): Response {
    return Response.json({ worker: "os-typechecker" }, { status: 404 });
  }

  async check(input: {
    files: Record<string, string>;
  }): Promise<{ diagnostics: TypecheckDiagnostic[] }> {
    const { files } = CheckInput.parse(input);
    return await runTypecheck({
      compiler: await compiler(),
      fetchImpl: (url) => fetch(url),
      files,
    });
  }
}
