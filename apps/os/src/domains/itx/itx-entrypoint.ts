import { WorkerEntrypoint } from "cloudflare:workers";
import { trustedInternalAuthContext } from "../../auth.ts";
import type { Env } from "../../env.ts";
import { itxForScope } from "../../rpc-targets.ts";
import { isWorkerBuildInProgressError } from "../workers/worker-loader.ts";
import { takeWorkerFetchDispatch } from "../workers/worker-fetch-dispatch.ts";
import { DynamicWorkerRunner } from "../workers/worker-runner.ts";
import { scopeFromItxEntrypointProps, type ItxEntrypointProps } from "./utils.ts";

/**
 * `env.ITX.get()` for a dynamic worker. It returns the itx for whatever scope the
 * host minted into this binding's props — the project root (`/`) for a project
 * worker, or an agent scope (`/agents/…`) for an agent script.
 *
 * There is deliberately no branching on the path: an agent context is not a
 * different type, it is the same {@link ProjectRpcTarget} fronting a deeper
 * scope's capability host. The agent's own `agent`/`chat` surface and the
 * capabilities of enclosing scopes come from the itx itself (getters + the
 * capability-host scope chain), not from a special entrypoint class.
 */
export class ItxEntrypoint extends WorkerEntrypoint<Env, ItxEntrypointProps> {
  async get() {
    const { path, projectId } = scopeFromItxEntrypointProps(this.ctx.props);
    return itxForScope({ auth: trustedInternalAuthContext(), ctx: this.ctx, path, projectId });
  }

  /**
   * Fetch-native dispatch into one of the project's dynamic workers —
   * `env.ITX.fetch(request)` with the target ref in the
   * `x-iterate-worker-dispatch` header (JSON `{ ref, buildBudgetMs? }`, same
   * ref shape as `project.workers.get`).
   *
   * This exists because WebSocket upgrades cannot cross RPC method calls: a
   * userspace router doing `app.fetch(req)` over `project.workers.get(ref)`
   * gets a DataCloneError when the 101 response's socket serializes back. The
   * binding itself is a loopback service stub, so ITS fetch handler is a real
   * upgrade-capable hop; from here the runner stays on fetch-native channels
   * (Durable Object stub fetch → facet fetch) all the way into the app.
   *
   * The authority is the binding's own scope: the ref executes under this
   * scope's project, exactly like `project.workers.get(ref)` would.
   */
  override async fetch(request: Request): Promise<Response> {
    const taken = takeWorkerFetchDispatch(request);
    if (taken === null) {
      return new Response(
        "env.ITX.fetch requires the x-iterate-worker-dispatch header naming a worker ref",
        { status: 400 },
      );
    }
    const { projectId } = scopeFromItxEntrypointProps(this.ctx.props);
    // A worker reached through this lane runs in the itx scope of its own
    // path, mirroring project.workers.get (DynamicWorkerRpcTarget#runner).
    const runner = new DynamicWorkerRunner({
      exports: this.ctx.exports,
      projectId,
      scopePath: taken.dispatch.ref.path,
      waitUntil: (promise) => this.ctx.waitUntil(promise),
    });
    try {
      return await runner.fetch({
        buildBudgetMs: taken.dispatch.buildBudgetMs,
        ref: taken.dispatch.ref,
        request: taken.request,
      });
    } catch (error) {
      // Fetch responses can't carry a named error across the hop the way RPC
      // does; a budget-expired cold build becomes a retryable 503 instead.
      if (!isWorkerBuildInProgressError(error)) throw error;
      return new Response("This worker is still building.", {
        headers: { "retry-after": "2" },
        status: 503,
      });
    }
  }
}
