import { RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
import type { Env } from "../../env.ts";
import type { ProjectEgress } from "../../types.ts";

const SECRET_PLACEHOLDER = /getSecret\("([^"]+)"\)/g;

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
 */
// [[ Should now be in rpc-targets.ts ]]
export class ProjectEgressEntrypoint extends WorkerEntrypoint<Env, { projectId: string }> {
  fetch(request: Request): Promise<Response> {
    return fetchProjectEgress(request, this.ctx.props.projectId);
  }
}

// [[ Should be in shared types.ts ]]

type ProjectEgressLoopbackExports = Record<
  "ProjectEgressEntrypoint",
  (options: { props: { projectId: string } }) => Fetcher
>;

// [[ is this really needed? single use helper? ]]
export function projectEgressFetcher(
  exports: ExecutionContext["exports"],
  projectId: string,
): Fetcher {
  return (exports as unknown as ProjectEgressLoopbackExports).ProjectEgressEntrypoint({
    props: { projectId },
  });
}

// [[ is this really needed? single use helper? ]]
function fetchProjectEgress(request: Request, projectId: string): Promise<Response> {
  return fetch(substituteProjectEgressHeaders(request, projectId));
}

// [[ is this really needed? single use helper? ]]
function substituteProjectEgressHeaders(request: Request, projectId: string): Request {
  const headers = new Headers(request.headers);
  headers.forEach((value, name) => {
    headers.set(name, substituteSecretPlaceholders(value, projectId));
  });
  return new Request(request, { headers });
}

// [[ is this really needed? single use helper? ]]
function substituteSecretPlaceholders(value: string, projectId: string): string {
  // POC substitution only: real secret storage/policy intentionally stays out of
  // minimal-itx-v4 until the egress shape is proven end to end.
  return value.replaceAll(SECRET_PLACEHOLDER, (_match, path: string) => {
    return `This is ${path} for ${projectId}`;
  });
}
