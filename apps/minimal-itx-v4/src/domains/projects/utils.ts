import { DurableObjectNameCodec } from "../durable-object-names.ts";
import { secretErrorResponse, secretReferencePathsFromHeaders } from "../secrets/utils.ts";

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
export function fetchProjectEgress(
  request: Request,
  input: {
    projectId: string;
    secrets: {
      getByName(name: string): { fetch(request: Request): Promise<Response> };
    };
  },
): Promise<Response> {
  let secretPaths: string[];
  try {
    secretPaths = secretReferencePathsFromHeaders(request.headers);
  } catch {
    return Promise.resolve(secretErrorResponse("secret_reference_required", 400));
  }
  if (secretPaths.length === 0) return fetch(request);
  if (secretPaths.length > 1) {
    return Promise.resolve(secretErrorResponse("multiple_secret_paths_not_supported", 400));
  }

  return input.secrets
    .getByName(
      DurableObjectNameCodec.stringify({ projectId: input.projectId, path: secretPaths[0]! }),
    )
    .fetch(request);
}
