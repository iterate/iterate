type MintedProjectId = { id: string };

/** All auth RPC attempts to mint a project id failed to answer inside their
 * bounded window. Named so telemetry distinguishes a stranded dependency
 * transport from project bootstrap or directory failures. */
export class ProjectIdMintDeadlineError extends Error {
  override readonly name = "ProjectIdMintDeadlineError";
}

// The RPC normally answers in under 500ms even while the preview fleet creates
// 60+ projects together. One observed native Workers RPC strand instead took
// 70.9s while its siblings kept completing normally. Minting is side-effect
// free, so a sparse fresh call is safe: an unused random id is not registered
// anywhere. Rejections retain their original semantics and are never retried.
const PROJECT_ID_MINT_ATTEMPT_TIMEOUTS_MS = [1_000, 2_000, 5_000] as const;
const PROJECT_ID_MINT_DEADLINE_MS = PROJECT_ID_MINT_ATTEMPT_TIMEOUTS_MS.reduce(
  (total, timeoutMs) => total + timeoutMs,
  0,
);

/** Mint through auth with sparse, bounded retries only when an RPC does not
 * settle. Each successor is a new service-binding call; the timed-out Promise
 * remains observed by Promise.race, so a late rejection is not unhandled. */
export async function mintProjectIdWithBoundedHedges(input: {
  mint: () => Promise<MintedProjectId>;
  slug: string;
}): Promise<MintedProjectId> {
  const startedAt = Date.now();

  for (const [index, timeoutMs] of PROJECT_ID_MINT_ATTEMPT_TIMEOUTS_MS.entries()) {
    const attempt = index + 1;
    const timeout = Symbol("project-id-mint-attempt-timeout");
    const call = Promise.resolve().then(input.mint);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const outcome = await Promise.race([
      call,
      new Promise<typeof timeout>((resolve) => {
        timer = setTimeout(() => resolve(timeout), timeoutMs);
      }),
    ]).finally(() => clearTimeout(timer));

    if (outcome !== timeout) {
      if (attempt > 1) {
        console.warn("auth project-id RPC completed after a bounded hedge", {
          attempt,
          elapsedMs: Date.now() - startedAt,
          slug: input.slug,
        });
      }
      return outcome;
    }

    if (attempt < PROJECT_ID_MINT_ATTEMPT_TIMEOUTS_MS.length) {
      console.warn("auth project-id RPC exceeded its hedge threshold", {
        attempt: attempt + 1,
        attemptTimeoutMs: timeoutMs,
        elapsedMs: Date.now() - startedAt,
        slug: input.slug,
      });
    }
  }

  const error = new ProjectIdMintDeadlineError(
    `Auth project-id mint exceeded ${PROJECT_ID_MINT_DEADLINE_MS}ms for ${input.slug}.`,
  );
  console.error("auth project-id RPC exhausted its bounded deadline", {
    attempts: PROJECT_ID_MINT_ATTEMPT_TIMEOUTS_MS.length,
    elapsedMs: Date.now() - startedAt,
    slug: input.slug,
  });
  throw error;
}
