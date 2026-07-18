import { disposeIgnoredRpcResult } from "iterate/live-state";

/**
 * Release an Artifacts repository RPC result without replacing the operation
 * that already acquired or used it. Cleanup failure is a separate ownership
 * defect: report it, but preserve the primary success or error exactly.
 */
export function disposeArtifactRepoResult(repo: unknown, operation: string): void {
  try {
    disposeIgnoredRpcResult(repo);
  } catch (error) {
    console.error("Artifacts repository RPC result disposal failed", {
      operation,
      error,
    });
  }
}

/** Acquire one write token while keeping the repository stub locally owned. */
export async function createArtifactWriteToken(
  artifacts: Pick<Artifacts, "get">,
  name: string,
  ttlSeconds: number,
): Promise<string> {
  const repo = await artifacts.get(name);
  try {
    const { plaintext } = await repo.createToken("write", ttlSeconds);
    return plaintext.split("?expires=")[0] ?? plaintext;
  } finally {
    disposeArtifactRepoResult(repo, "create write token");
  }
}
