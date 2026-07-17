import { WorkerEntrypoint } from "cloudflare:workers";
import { trustedInternalAuthContext } from "../../auth.ts";
import type { Env } from "../../env.ts";
import { deploymentItxForTrustedInternal, itxForScope } from "../../rpc-targets.ts";
import {
  isWorkerBuildFailedError,
  isWorkerBuildInProgressError,
} from "../workers/worker-loader.ts";
import {
  takeWorkerFetchDispatch,
  workerBuildingResponse,
} from "../workers/worker-fetch-dispatch.ts";
import { workerBuildFailedResponse } from "../workers/worker-serve-overlay.ts";
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
    if (projectId === null) {
      // The deployment-global scope: what a GLOBAL (projectId: null) stream's
      // delivery dial evaluates expressions against. It is the same root a
      // trusted-internal session sees — deployment-wide repos/streams — so a
      // global repo stream's wake expression walks the identical shape a
      // project stream's does.
      return deploymentItxForTrustedInternal({ ctx: this.ctx });
    }
    return itxForScope({ auth: trustedInternalAuthContext(), ctx: this.ctx, path, projectId });
  }

  /**
   * The fetch-native worker lane for userspace: `env.ITX.fetch(request)` with
   * the target ref in the `x-iterate-worker-dispatch` header (JSON
   * `{ ref, buildBudgetMs? }`, same ref shape as `project.workers.get`).
   *
   * HTTP into a dynamic worker always goes through here — the seeded router
   * dispatches every app request this way, not just WebSockets. The binding
   * is a loopback service stub, so its fetch handler is a real fetch hop, and
   * from here the runner stays on fetch-native channels (loader entrypoint
   * fetch; Durable Object stub fetch → facet fetch) all the way into the app.
   * That is what lets 101 upgrades and streaming bodies tunnel through —
   * RPC method calls (`app.fetch(req)` on a worker stub) cannot carry them.
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
    if (projectId === null) {
      return new Response("the global itx scope has no workers to dispatch to", { status: 400 });
    }
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
      // does; a budget-expired cold build becomes the retryable building
      // page, a failed first-ever build the build-failed page.
      if (isWorkerBuildInProgressError(error)) return workerBuildingResponse();
      if (isWorkerBuildFailedError(error)) return workerBuildFailedResponse(error);
      throw error;
    }
  }
}
