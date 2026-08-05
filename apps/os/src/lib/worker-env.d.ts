import type { Env as OsEnv } from "../env.ts";

/**
 * OS deploys as ONE worker (src/worker.ts); `src/env.ts` is its binding
 * contract, matching the bindings wrangler.jsonc declares (generated from
 * the root envs.ts by scripts/generate-wrangler-config.ts). The ambient
 * global `Env` and the `cloudflare:workers` module env are both that
 * contract.
 */
export interface CloudflareEnv extends OsEnv {}

/**
 * The `ctx.exports` surface: the loopback entrypoints exported by the worker
 * entry (src/worker.ts).
 */
type WorkerMainModule = {
  ItxEntrypoint: (typeof import("../domains/itx/itx-entrypoint.ts"))["ItxEntrypoint"];
  LiveCapabilityRelayEntrypoint: (typeof import("../domains/capability-host/live-capability-relay-entrypoint.ts"))["LiveCapabilityRelayEntrypoint"];
  ProjectEgressEntrypoint: (typeof import("../domains/projects/egress.ts"))["ProjectEgressEntrypoint"];
  ScriptExecutionEntrypoint: (typeof import("../domains/capability-host/script-execution-entrypoint.ts"))["ScriptExecutionEntrypoint"];
};

declare global {
  type Env = CloudflareEnv;

  interface ExecutionContext<Props = unknown> {
    readonly exports: Cloudflare.Exports;
  }

  interface DurableObjectState<Props = unknown> {
    readonly exports: Cloudflare.Exports;
  }

  namespace Cloudflare {
    /**
     * Tell Cloudflare's runtime types that OS's Worker loopback exports are
     * the shared loopback surface.
     *
     * First-party docs:
     *
     * - `ctx.exports` is the Workers loopback binding API:
     *   https://developers.cloudflare.com/workers/runtime-apis/context/#exports
     * - Cloudflare recommends generated `GlobalProps` for precise
     *   `ctx.exports` and `ctx.props` typing:
     *   https://developers.cloudflare.com/workers/runtime-apis/context/#typescript-types-for-ctxexports-and-ctxprops
     * - The `enable_ctx_exports` compatibility flag controls the runtime API:
     *   https://developers.cloudflare.com/workers/configuration/compatibility-flags/#enable-ctxexports
     *
     * OS uses `ctx.exports` for loopback entrypoints. Durable Object calls go
     * through explicit env namespace bindings, so `durableNamespaces` is
     * empty — that also avoids circular mapped types for Durable Objects.
     */
    interface GlobalProps {
      mainModule: WorkerMainModule;
      durableNamespaces: never;
    }
  }
}

declare module "cloudflare:workers" {
  namespace Cloudflare {
    export interface Env extends CloudflareEnv {}
  }
}
