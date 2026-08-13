import { WorkerEntrypoint } from "cloudflare:workers";
import { ZodError } from "zod";
import { streamDeliveryAuthContext, trustedInternalAuthContext } from "../../auth.ts";
import type { Env } from "../../env.ts";
import { deploymentItxForInternal, itxForScope } from "../../rpc-targets.ts";
import {
  buildBudgetForRequest,
  takeWorkerFetchDispatch,
  workerBuildStatus,
} from "../workers/worker-fetch-dispatch.ts";
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
 * capabilities beyond this scope come from the itx itself (getters + the
 * capability host's journaled fallback), not from a special entrypoint class.
 */
export class ItxEntrypoint extends WorkerEntrypoint<Env, ItxEntrypointProps> {
  async get() {
    const { path, projectId, purpose, streamContext } = scopeFromItxEntrypointProps(this.ctx.props);
    const auth =
      purpose === "stream-delivery"
        ? streamDeliveryAuthContext(projectId)
        : trustedInternalAuthContext();
    if (!projectId) {
      // The deployment-global scope: what a GLOBAL (projectId: null) stream's
      // delivery dial evaluates expressions against. It is the same root a
      // trusted-internal session sees — deployment-wide repos/streams — so a
      // global repo stream's wake expression walks the identical shape a
      // project stream's does.
      return deploymentItxForInternal({ auth, ctx: this.ctx });
    }
    return itxForScope({ auth, ctx: this.ctx, path, projectId, streamContext });
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
    let taken: ReturnType<typeof takeWorkerFetchDispatch>;
    try {
      taken = takeWorkerFetchDispatch(request);
    } catch (error) {
      if (!(error instanceof SyntaxError || error instanceof ZodError)) throw error;
      return new Response("invalid x-iterate-worker-dispatch header", { status: 400 });
    }
    if (!taken) {
      return new Response(
        "env.ITX.fetch requires the x-iterate-worker-dispatch header naming a worker ref",
        { status: 400 },
      );
    }
    const { projectId, streamContext } = scopeFromItxEntrypointProps(this.ctx.props);
    if (!projectId) {
      return new Response("the global itx scope has no workers to dispatch to", { status: 400 });
    }
    // A worker reached through this lane runs in the itx scope of its own
    // path, mirroring project.workers.get (DynamicWorkerRpcTarget#runner).
    const runner = new DynamicWorkerRunner({
      streamContext,
      exports: this.ctx.exports,
      projectId,
      scopePath: taken.dispatch.ref.path,
    });
    try {
      // Routers forward the browser's own headers, so a document navigation
      // is recognizable on this hop too — clamp the dispatcher's budget the
      // way ingress clamps its own, or an app-level first build holds the
      // page blank for the SDK's full default.
      return await runner.fetch({
        buildBudgetMs: buildBudgetForRequest(taken.request, taken.dispatch.buildBudgetMs),
        ref: taken.dispatch.ref,
        request: taken.request,
      });
    } catch (error) {
      // Fetch responses can't carry a named error across the hop the way RPC
      // does; a budget-expired cold build becomes the retryable building
      // page, a failed first-ever build the build-failed page.
      const buildStatus = workerBuildStatus(
        error,
        taken.request.headers.get("x-iterate-url-prefix") ?? "",
      );
      if (buildStatus) return buildStatus.response;
      throw error;
    }
  }
}
