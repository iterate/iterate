import type { workers } from "../../alchemy.run.ts";

/**
 * OS deploys as many small workers (alchemy.run.ts `workers`), each with its
 * own binding set. The ambient global `Env` covers the two dashboard-side
 * workers (app + ingress); the engine workers deliberately do not participate
 * in it — engine code imports its own binding contract from src/env.ts,
 * so neither side's types leak into the other.
 */
type W = typeof workers;

type AppWorkerEnv = W["app"]["Env"];
type IngressWorkerEnv = W["ingress"]["Env"];

// An interface (not a type alias) so TypeScript resolves the extends clauses
// lazily: Env feeds worker binding types in alchemy.run.ts, which feed Env —
// a cycle that a type-alias intersection evaluates eagerly (TS7022) and
// interface inheritance defers.
export interface CloudflareEnv extends AppWorkerEnv, IngressWorkerEnv {}

/**
 * The `ctx.exports` surface every engine worker shares: the loopback
 * entrypoints re-exported by each engine worker entry (src/workers/*).
 */
type WorkerMainModule = {
  ItxEntrypoint: (typeof import("../domains/itx/itx-entrypoint.ts"))["ItxEntrypoint"];
  ProjectEgressEntrypoint: (typeof import("../domains/projects/egress.ts"))["ProjectEgressEntrypoint"];
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
