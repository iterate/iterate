import { WorkerEntrypoint } from "cloudflare:workers";
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
  createCompiler({ wasm: typescriptWasm as WebAssembly.Module }),
);

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

  async check(input: { files: Record<string, string> }): Promise<TypecheckResult> {
    const { files } = CheckInput.parse(input);
    const compilerPromise = compilerCache.get();
    const result = await runTypecheck({
      compiler: await compilerPromise,
      fetchImpl: typmFetch,
      files,
    });
    // runTypecheck turns a mid-compile crash (the wasm program exiting) into a
    // code-0 diagnostic. The compiler instance may now be permanently dead, so
    // drop it: the next check re-instantiates rather than reusing the corpse
    // and reporting a crash forever (which the gate reads as unchecked → the
    // gate would silently fail open). Cheap re-instantiation (~40ms) is the
    // right price to keep the gate honest.
    if (result.diagnostics.some((diagnostic) => diagnostic.code === 0)) {
      compilerCache.resetIfCurrent(compilerPromise);
    }
    return result;
  }
}
