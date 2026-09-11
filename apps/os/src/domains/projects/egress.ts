import { WorkerEntrypoint } from "cloudflare:workers";
import type { Env } from "../../env.ts";
import { DurableObjectNameCodec } from "../durable-object-names.ts";
import { withStreamContext, type StreamContext } from "./stream-context.ts";

/**
 * Live project egress handler. It sees getSecret(...) placeholders, never material.
 * Call next(request) to continue through ordinary approvals and secret substitution.
 * Bare fetch() in a hosted script re-enters interception instead.
 */
export type ProjectEgressInterceptor = (
  request: Request,
  next: (request: Request) => Promise<Response>,
) => Promise<Response>;

/**
 * What `egress.fetch` resolves: a real fetch `Response`, with `json()` pinned
 * to `Promise<unknown>` ahead of the ambient signature. Pinned because the
 * ambient resolution is a compiler-settings artifact — which `lib`/`types` a
 * consumer compiles with decides whether `await response.json()` is `any`
 * (DOM lib alone), `unknown` (the current DOM + workers-types merge), or the
 * useless `Promise<{}>` (older merges, where workers-types'
 * `json<T>(): Promise<T>` inferred `{}`). The first-position member makes
 * every consumer see the same honest `unknown`: narrow or cast it to the
 * shape you expect, or `JSON.parse(await response.text())` in plain-JS
 * scripts that read the body dynamically.
 */
export type EgressResponse = {
  /** The parsed JSON body — honestly `unknown`; the caller supplies the shape. */
  json(): Promise<unknown>;
} & Response;

/** Disposable handle for one live project egress interception. */
export interface ProjectEgressIntercept extends Disposable {
  release(): Promise<void>;
}

/**
 * Host-minted Fetcher for Dynamic Worker `globalOutbound`. Workerd requires a
 * platform Fetcher here; a plain object with fetch() fails runtime validation.
 *
 * This named entrypoint stays as the Worker Loader gateway, but it immediately
 * forwards to the Project Durable Object so explicit RPC egress and dynamic
 * worker bare `fetch()` share one decision point.
 */
export class ProjectEgressEntrypoint extends WorkerEntrypoint<
  Env,
  { projectId: string; streamContext: StreamContext }
> {
  fetch(request: Request): Promise<Response> {
    return projectStub(this.env.PROJECT, this.ctx.props.projectId).fetch(
      withStreamContext(request, this.ctx.props.streamContext),
    );
  }
}

export function projectStub(projects: Env["PROJECT"], projectId: string) {
  return projects.getByName(DurableObjectNameCodec.stringify({ path: "/", projectId }));
}
