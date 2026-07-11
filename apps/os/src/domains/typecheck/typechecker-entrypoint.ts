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

  async check(input: { files: Record<string, string> }): Promise<TypecheckResult> {
    const { files } = CheckInput.parse(input);
    return await runTypecheck({
      compiler: await compiler(),
      fetchImpl: typmFetch,
      files,
    });
  }
}
