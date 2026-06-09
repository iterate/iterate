import type { worker } from "../../alchemy.run.ts";

export type CloudflareEnv = typeof worker.Env;

type WorkerEntryExports = typeof import("../entry.workerd.ts");
type WorkerMainModule = Pick<
  WorkerEntryExports,
  Extract<
    keyof WorkerEntryExports,
    | "AgentCapability"
    | "AiCapability"
    | "FetchCapability"
    | "GmailCapability"
    | "ItxEntrypoint"
    | "ProjectEgress"
    | "OpenApiBridge"
    | "OrpcCapability"
    | "ProjectCapability"
    | "ProjectIngressEntrypoint"
    | "ProjectMcpServerEntrypoint"
    | "RepoCapability"
    | "ReposCapability"
    | "SecretsCapability"
    | "SlackCapability"
    | "StreamsCapability"
    | "WorkspaceCapability"
  >
>;

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
     * exactly the exports from `entry.workerd.ts`.
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
     * We deliberately do not maintain a parallel list of WorkerEntrypoint or
     * capability classes here. `mainModule` points at the whole Worker entry
     * module, so every top-level export participates in Cloudflare's own
     * `Cloudflare.Exports` mapper.
     *
     * OS uses `ctx.exports` for loopback entrypoints and capabilities. Durable
     * Object calls go through explicit env namespace bindings, so `mainModule`
     * deliberately exposes only the loopback classes and `durableNamespaces` is
     * empty. That avoids circular mapped types for mixin-heavy Durable Objects.
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
