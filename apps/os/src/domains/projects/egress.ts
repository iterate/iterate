import { WorkerEntrypoint } from "cloudflare:workers";
import type { Env } from "../../env.ts";
import { DurableObjectNameCodec } from "../durable-object-names.ts";

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

export function projectStub(projects: Env["PROJECT"], projectId: string) {
  return projects.getByName(DurableObjectNameCodec.stringify({ path: "/", projectId }));
}
