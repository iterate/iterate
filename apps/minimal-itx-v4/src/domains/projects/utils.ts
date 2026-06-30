const SECRET_PLACEHOLDER = /getSecret\("([^"]+)"\)/g;

/**
 * Narrow structural view of the loopback export we need from
 * `ExecutionContext.exports`.
 *
 * Keeping this local avoids making the app-wide `Env` contract depend on this
 * proof-of-concept egress shape.
 */
type ProjectEgressLoopbackExports = Record<
  "ProjectEgressEntrypoint",
  (options: { props: { projectId: string } }) => Fetcher
>;

/**
 * Returns a platform Fetcher for Worker Loader `globalOutbound`.
 *
 * Worker Loader validates this as a real workerd Fetcher, so callers cannot
 * pass a plain `{ fetch() {} }` object even though the behavior is tiny.
 */
export function projectEgressFetcher(
  exports: ExecutionContext["exports"],
  projectId: string,
): Fetcher {
  return (exports as unknown as ProjectEgressLoopbackExports).ProjectEgressEntrypoint({
    props: { projectId },
  });
}

/**
 * Shared egress implementation for the public RPC target and WorkerEntrypoint
 * loopback so both paths get identical placeholder substitution.
 */
export function fetchProjectEgress(request: Request, projectId: string): Promise<Response> {
  return fetch(substituteProjectEgressHeaders(request, projectId));
}

/**
 * Rebuilds the request because Headers are the only POC surface that currently
 * supports project-secret placeholders.
 */
function substituteProjectEgressHeaders(request: Request, projectId: string): Request {
  const headers = new Headers(request.headers);
  headers.forEach((value, name) => {
    headers.set(name, substituteSecretPlaceholders(value, projectId));
  });
  return new Request(request, { headers });
}

/**
 * Keeps the fake secret syntax in one place while egress is still a proof of
 * concept. The real OS path will replace this with policy-backed secret reads.
 */
function substituteSecretPlaceholders(value: string, projectId: string): string {
  // POC substitution only: real secret storage/policy intentionally stays out of
  // minimal-itx-v4 until the egress shape is proven end to end.
  return value.replaceAll(SECRET_PLACEHOLDER, (_match, path: string) => {
    return `This is ${path} for ${projectId}`;
  });
}
