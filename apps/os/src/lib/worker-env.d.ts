import type { workers } from "../../alchemy.run.ts";
import type * as CloudflareBindings from "alchemy/Cloudflare";

/**
 * OS deploys as many small workers (alchemy.run.ts `workers`), each with its
 * own binding set. Shared code keeps ONE global `Env`: the union of every
 * worker's bindings, with each binding typed as it is wherever it exists.
 * Whether a binding is actually present at runtime depends on which worker
 * the module runs in — per-class narrow Env types (e.g.
 * ProjectIngressEntrypointEnv) remain the precision mechanism, and code that
 * can run where a binding is absent must feature-check it.
 */
type W = typeof workers;
type NormalizeEnv<T> = {
  [K in keyof T]: T[K] extends CloudflareBindings.Worker ? Fetcher : T[K];
};

type AppWorkerEnv = NormalizeEnv<CloudflareBindings.InferEnv<W["app"]>>;
type AgentWorkerEnv = NormalizeEnv<CloudflareBindings.InferEnv<W["agent"]>>;
type IngressWorkerEnv = NormalizeEnv<CloudflareBindings.InferEnv<W["ingress"]>>;
type ItxWorkerEnv = NormalizeEnv<CloudflareBindings.InferEnv<W["itx"]>>;
type McpWorkerEnv = NormalizeEnv<CloudflareBindings.InferEnv<W["mcp"]>>;
type ProjectWorkerEnv = NormalizeEnv<CloudflareBindings.InferEnv<W["project"]>>;
type RepoWorkerEnv = NormalizeEnv<CloudflareBindings.InferEnv<W["repo"]>>;
type SlackAgentWorkerEnv = NormalizeEnv<CloudflareBindings.InferEnv<W["slackAgent"]>>;
type SlackIntegrationWorkerEnv = NormalizeEnv<CloudflareBindings.InferEnv<W["slackIntegration"]>>;
type StreamWorkerEnv = NormalizeEnv<CloudflareBindings.InferEnv<W["stream"]>>;
type WorkspaceWorkerEnv = NormalizeEnv<CloudflareBindings.InferEnv<W["workspace"]>>;
type DebugSubscriberWorkerEnv = Partial<
  NormalizeEnv<CloudflareBindings.InferEnv<W["debugSubscriber"]>>
>;

// An interface (not a type alias) so TypeScript resolves the extends clauses
// lazily: Env feeds the Durable Object classes' own types, which feed the
// worker binding types in alchemy.run.ts, which feed Env — a cycle that a
// type-alias intersection evaluates eagerly (TS7022) and interface
// inheritance defers.
export interface CloudflareEnv
  extends
    AppWorkerEnv,
    AgentWorkerEnv,
    IngressWorkerEnv,
    ItxWorkerEnv,
    McpWorkerEnv,
    ProjectWorkerEnv,
    RepoWorkerEnv,
    SlackAgentWorkerEnv,
    SlackIntegrationWorkerEnv,
    StreamWorkerEnv,
    WorkspaceWorkerEnv,
    DebugSubscriberWorkerEnv {
  AI: Ai;
}

/**
 * The `ctx.exports` surface itx-hosting workers share: the loopback
 * capability classes (workers/shared/loopback-exports.ts) plus the
 * project-host lane entrypoints exported by the project worker. This is the
 * superset across workers — same posture as Env above.
 */
type WorkerMainModule = typeof import("../workers/shared/loopback-exports.ts") & {
  ItxCapabilityIngress: (typeof import("../itx/http.ts"))["ItxCapabilityIngress"];
  ProjectIngressEntrypoint: (typeof import("../domains/projects/entrypoints/project-ingress-entrypoint.ts"))["ProjectIngressEntrypoint"];
  ProjectMcpServerEntrypoint: (typeof import("../domains/inbound-mcp-server/entrypoints/project-mcp-server-entrypoint.ts"))["ProjectMcpServerEntrypoint"];
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
     * the shared loopback surface (plus lane entrypoints).
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
     * OS uses `ctx.exports` for loopback entrypoints and capabilities. Durable
     * Object calls go through explicit env namespace bindings, so
     * `durableNamespaces` is empty — that also avoids circular mapped types
     * for mixin-heavy Durable Objects.
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
