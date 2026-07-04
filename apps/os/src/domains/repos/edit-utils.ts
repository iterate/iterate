export function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let index = 0;
  while ((index = haystack.indexOf(needle, index)) !== -1) {
    count++;
    index += needle.length;
  }
  return count;
}

export function replaceLiteralOccurrences(input: {
  content: string;
  newString: string;
  oldString: string;
}): string {
  return input.content.split(input.oldString).join(input.newString);
}

/**
 * True when a git push failed because a concurrent writer advanced the branch
 * HEAD first — the remote's optimistic-concurrency (compare-and-swap) rejection,
 * surfaced by isomorphic-git as a GitPushError ("stale ref"/not-fast-forward)
 * or a PushRejectedError. Repo mutations retry the clone→mutate→push cycle on
 * these so concurrent writers to one branch serialize instead of clobbering
 * each other (see mutateArtifactRepo in repo-durable-object.ts). Kept pure and
 * separate from the Durable Object so it can be unit-tested without the Workers
 * runtime.
 */
export function isConcurrentPushRejection(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as { code?: string }).code;
  if (code === "PushRejectedError") return true;
  const haystack = `${error.message} ${JSON.stringify((error as { data?: unknown }).data ?? "")}`;
  return /stale ref|not[- ]fast[- ]forward|not a simple fast-forward|fetch first/i.test(haystack);
}
