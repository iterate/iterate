import { RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
import type { Env } from "../../env.ts";
import type { ProjectEgress } from "../../types.ts";
import { fetchProjectEgress } from "./utils.ts";

/**
 * Project-scoped outbound fetch. This is deliberately much smaller than the OS
 * egress system: no policy registry, no live shadowing, and no real secret
 * store yet. The goal is to prove that explicit project egress and dynamic
 * worker global fetch share one pipe.
 */
export class ProjectEgressRpcTarget extends RpcTarget implements ProjectEgress {
  constructor(readonly props: { projectId: string }) {
    super();
  }

  fetch(request: Request): Promise<Response> {
    return fetchProjectEgress(request, this.props.projectId);
  }
}

/**
 * Host-minted Fetcher for Dynamic Worker `globalOutbound`. Workerd requires a
 * platform Fetcher here; a plain object with fetch() fails runtime validation.
 *
 * This stays in the project egress domain beside `ProjectEgressRpcTarget`
 * because both public RPC egress and dynamic-worker egress must share the same
 * placeholder substitution behavior.
 */
export class ProjectEgressEntrypoint extends WorkerEntrypoint<Env, { projectId: string }> {
  fetch(request: Request): Promise<Response> {
    return fetchProjectEgress(request, this.ctx.props.projectId);
  }
}
