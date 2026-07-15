import { tracing, WorkerEntrypoint } from "cloudflare:workers";
import { z } from "zod";
import { createCompiler, type Compiler } from "tswasm";
import { createCachedFetch } from "@iterate-com/typm/cached-fetch";
// The typescript-go compiler as a wasm module (~30MB raw, ~7MB gzip) — the
// whole reason this is a sidecar worker: the product script stays lean, the
// same way the builder quarantines esbuild-wasm. Two sidecars because they
// CANNOT be one: esbuild-wasm + tswasm gzip to ~11 MiB, over Cloudflare's
// 10 MiB compressed script limit (upload rejected, error 10027).
import typescriptWasm from "tswasm/tswasm.wasm";
import { runTypecheck, type TypecheckResult } from "./run-typecheck.ts";
import { createCompilerCache } from "./compiler-cache.ts";

/** The whole input is inert data: a virtual file map. The checker holds no
 * bindings and grants no authority; it does make outbound GETs the input
 * names — npm type metadata (jsdelivr) and `openapi:` spec URLs. */
const CheckInput = z.object({
  files: z.record(z.string(), z.string()),
  /** Virtual path whose emitted JavaScript should come back as result.js —
   * check and emit are one wasm compile, so naming it costs nothing. */
  entrypoint: z.string().optional(),
});

/** Npm type downloads ride the Cache API (same recipe and cache name as the
 * repo IDE's type acquisition), so a fresh isolate re-reads the Slack SDK's
 * .d.ts tree from the local Cloudflare cache instead of jsdelivr. Version
 * resolutions are never cached — they move as packages publish. */
const typmFetch = createCachedFetch({
  fetch: (url) => fetch(url),
  cacheName: "typm-v1",
  // Only jsdelivr's exact-versioned URLs are immutable (the Cache API
  // contract); version resolutions move as packages publish, and openapi:
  // spec URLs are unversioned by nature — never pin either.
  shouldCache: (url) =>
    url.startsWith("https://cdn.jsdelivr.net/") && !url.includes("/package/resolve/"),
});

/** One wasm instantiation per isolate, shared across requests. Drops the
 * instance on a failed instantiation AND after a mid-compile crash (see
 * compiler-cache.ts and the reset in `check`). */
const compilerCache = createCompilerCache<Compiler>(() =>
  tracing.enterSpan("typechecker.compiler.create", (span) => {
    span.setAttribute("iterate.typecheck.compiler", "typescript-go-wasm");
    return createCompiler({ wasm: typescriptWasm as WebAssembly.Module });
  }),
);

function fileChars(files: Record<string, string>): number {
  return Object.values(files).reduce((total, text) => total + text.length, 0);
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
    entrypoint?: string;
  }): Promise<TypecheckResult> {
    return tracing.enterSpan("typechecker.check", async (span) => {
      const { files, entrypoint } = CheckInput.parse(input);
      span.setAttribute("iterate.typecheck.request_file_count", Object.keys(files).length);
      span.setAttribute("iterate.typecheck.request_chars", fileChars(files));
      span.setAttribute("iterate.typecheck.has_entrypoint", entrypoint !== undefined);

      const compilerPromise = compilerCache.get();
      const compiler = await compilerPromise;
      const result = await runTypecheck({
        compiler: {
          compile: (request) =>
            tracing.enterSpan("typechecker.compile", (compileSpan) => {
              compileSpan.setAttribute(
                "iterate.typecheck.effective_file_count",
                Object.keys(request.files).length,
              );
              compileSpan.setAttribute(
                "iterate.typecheck.effective_chars",
                fileChars(request.files),
              );
              compileSpan.setAttribute(
                "iterate.typecheck.has_entrypoint",
                request.entrypoint !== undefined,
              );
              const compiled = compiler.compile(request);
              compileSpan.setAttribute(
                "iterate.typecheck.diagnostic_count",
                compiled.diagnostics.length,
              );
              compileSpan.setAttribute("iterate.typecheck.emitted_chars", compiled.js?.length ?? 0);
              return compiled;
            }),
        },
        fetchImpl: typmFetch,
        files,
        entrypoint,
      });
      span.setAttribute("iterate.typecheck.diagnostic_count", result.diagnostics.length);
      span.setAttribute("iterate.typecheck.note_count", result.notes.length);
      span.setAttribute("iterate.typecheck.emitted_chars", result.js?.length ?? 0);

      // runTypecheck turns a mid-compile crash (the wasm program exiting) into a
      // code-0 diagnostic. The compiler instance may now be permanently dead, so
      // drop it: the next check re-instantiates rather than reusing the corpse
      // and reporting a crash forever (which the gate reads as unchecked → the
      // gate would silently fail open). Cheap re-instantiation (~40ms) is the
      // right price to keep the gate honest.
      if (result.diagnostics.some((diagnostic) => diagnostic.code === 0)) {
        span.setAttribute("iterate.typecheck.outcome", "compiler_crash");
        compilerCache.resetIfCurrent(compilerPromise);
      } else {
        span.setAttribute("iterate.typecheck.outcome", "ok");
      }
      return result;
    });
  }
}
