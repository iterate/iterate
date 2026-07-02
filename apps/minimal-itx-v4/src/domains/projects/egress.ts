import { env, RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
import type { Env } from "../../env.ts";
import type { ProjectEgress } from "../../types.ts";
import { DurableObjectNameCodec } from "../durable-object-names.ts";

/**
 * Public project egress facet.
 *
 * The Project Durable Object is the single egress decision point: it owns the
 * live runtime interceptor slot and, when there is no interceptor, performs the
 * terminal secret-substitution fetch path.
 */
export class ProjectEgressRpcTarget extends RpcTarget implements ProjectEgress {
  constructor(readonly props: { projectId: string }) {
    super();
  }

  fetch(request: Request): Promise<Response> {
    return projectStub(env.PROJECT, this.props.projectId).fetch(request);
  }

  intercept(handler: Parameters<ProjectEgress["intercept"]>[0]) {
    return projectStub(env.PROJECT, this.props.projectId).interceptEgress(handler);
  }

  useEgressHttpsProxy(relay: Parameters<ProjectEgress["useEgressHttpsProxy"]>[0]) {
    return projectStub(env.PROJECT, this.props.projectId).useEgressHttpsProxy(relay);
  }
}

/**
 * Host-minted Fetcher for Dynamic Worker `globalOutbound`. Workerd requires a
 * platform Fetcher here; a plain object with fetch() fails runtime validation.
 *
 * This named entrypoint stays as the Worker Loader gateway, but it immediately
 * forwards to the Project Durable Object so explicit RPC egress and dynamic
 * worker bare `fetch()` share one decision point.
 */
export class ProjectEgressEntrypoint extends WorkerEntrypoint<Env, { projectId: string }> {
  fetch(request: Request): Promise<Response> {
    return projectStub(this.env.PROJECT, this.ctx.props.projectId).fetch(request);
  }
}

function projectStub(projects: Env["PROJECT"], projectId: string) {
  return projects.getByName(DurableObjectNameCodec.stringify({ path: "/", projectId }));
}
