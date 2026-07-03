import { WorkerEntrypoint } from "cloudflare:workers";
import { z } from "zod";
import type { Env } from "../../env.ts";
import { normalizePath } from "../durable-object-names.ts";
import {
  itxEntrypointBinding,
  itxEntrypointProps,
  itxEntrypointScopeCacheKey,
} from "../itx/utils.ts";
import { projectEgressFetcher } from "../projects/utils.ts";
import type { DynamicWorkerRef } from "../../types.ts";
import { DynamicWorkerRef as DynamicWorkerRefSchema } from "./schemas.ts";
import { DynamicWorkerRunner } from "./worker-runner.ts";

/**
 * The one place dynamic workers run: the worker worker's default entrypoint.
 *
 * Every other worker reaches dynamic workers through its `DYNAMIC_WORKERS`
 * service binding instead of holding a Worker Loader of its own:
 *
 * ```ts
 * await env.DYNAMIC_WORKERS.invokeCapability({
 *   projectId,
 *   scopePath: "/agents/demo",
 *   ref,                       // DynamicWorkerRef (stateless or stateful)
 *   path: ["fetch"],           // dotted capability path on the loaded worker
 *   args: [request],
 * });
 * ```
 *
 * Why single ownership (rather than a LOADER binding per worker):
 *
 * - **One isolate per source.** Loader caches are scoped to the worker that
 *   owns the binding, so N callers previously meant up to N warm copies of the
 *   same dynamic worker — N cold starts and N steps closer to the platform's
 *   concurrent-isolate cap. Now there is exactly one cache.
 * - **Authority is minted at one validated boundary.** A loaded worker's
 *   `env.ITX` and global outbound (`globalOutbound` → project egress) are
 *   loopback capabilities built from the hosting worker's own `ctx.exports`.
 *   Centralising means exactly one worker's stubs ever live inside dynamic
 *   worker envs, and the project/scope confinement they encode is derived from
 *   the *data* of this call — parsed below — instead of ambient context at
 *   four different call sites.
 * - **The cross-parent cache bug is structurally impossible.** A cached
 *   isolate is only ever invoked by the worker whose loopback stubs it holds.
 *   (Local dev runs every worker in one workerd whose loader cache is shared
 *   across parents; an isolate created by one worker and invoked from another
 *   failed with a redacted internal error — see the WORKER_SELF cache-key
 *   component in worker-loader.ts, which stays as defense in depth.)
 *
 * Contract notes:
 *
 * - `args` and the return value are deliberately NOT validated or copied:
 *   they may carry live RPC stubs in both directions (Workers RPC duplicates
 *   stubs in params; returned RpcTargets must remain live capabilities for the
 *   outer caller). Everything else is parsed before any authority is derived.
 * - `scopePath` is the itx scope the loaded worker's `env.ITX.get()` resolves
 *   to. It is usually `ref.path` (a worker mounted at its own path), but e.g.
 *   run-script workers execute inside the scope of the ITX object that owns
 *   the script, so callers state it explicitly.
 * - Stateful refs are forwarded to `StatefulWorkerDurableObject` (also hosted
 *   by this worker), which owns class instantiation and storage affinity.
 */
export class DynamicWorkerEntrypoint extends WorkerEntrypoint<Env> {
  /** The worker worker serves no HTTP; everything arrives over RPC. */
  override fetch(): Response {
    return Response.json({ worker: "os-worker" }, { status: 404 });
  }

  async invokeCapability(input: {
    projectId: string;
    scopePath: string;
    ref: DynamicWorkerRef;
    path: string[];
    args?: unknown[];
    flattenNestedPath?: boolean;
  }): Promise<unknown> {
    // `args` passes through untouched (may hold live stubs); everything that
    // grants authority — project, scope, worker ref, capability path — is
    // validated here, at the single boundary where isolates get their env.
    const { projectId, scopePath, ref, path, flattenNestedPath } =
      InvokeCapabilityInput.parse(input);
    const itxScope = itxEntrypointProps({ path: scopePath, projectId });
    const runner = new DynamicWorkerRunner({
      bindings: {
        ITX: itxEntrypointBinding(this.ctx.exports, itxScope),
      },
      globalOutbound: projectEgressFetcher(this.ctx.exports, projectId),
      loader: this.env.LOADER,
      projectId,
      workerScopeKey: itxEntrypointScopeCacheKey(itxScope),
    });
    return await runner.invokeCapability({
      args: input.args ?? [],
      flattenNestedPath,
      path,
      ref,
    });
  }
}

/** Everything of `invokeCapability`'s input except the pass-through `args`. */
const InvokeCapabilityInput = z.object({
  projectId: z.string().trim().min(1),
  scopePath: z.string().trim().min(1).transform(normalizePath),
  ref: DynamicWorkerRefSchema,
  path: z.array(z.string().min(1)).min(1),
  flattenNestedPath: z.boolean().default(false),
});
