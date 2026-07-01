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
