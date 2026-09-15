/**
 * Whether a substitution request may run against the secret state this
 * Durable Object incarnation already read, instead of pulling the fold
 * snapshot through the secret's own stream again.
 *
 * Every substitution used to pay that cross-Durable-Object snapshot (~20 ms
 * warm, seconds cold) in front of the upstream call. The state only changes
 * through this object's own writes — which drop the held copy — or through a
 * direct append to the secret stream, which the time bound covers.
 */
export const SUBSTITUTION_SNAPSHOT_MAX_AGE_MS = 30_000;

export type SubstitutionRevision =
  | { kind: "any-revision" }
  | { kind: "exact-revision"; updatedOffset: number };

export function reusableSubstitutionSnapshot<State extends { updatedOffset: number }>(input: {
  held: { state: State; readAtMs: number } | undefined;
  nowMs: number;
  revision: SubstitutionRevision;
}): State | null {
  const { held } = input;
  if (held === undefined) return null;
  if (input.nowMs - held.readAtMs > SUBSTITUTION_SNAPSHOT_MAX_AGE_MS) return null;
  if (
    input.revision.kind === "exact-revision" &&
    held.state.updatedOffset !== input.revision.updatedOffset
  ) {
    // A caller pinned to a revision the held copy predates: read again so a
    // just-rotated credential is not refused from stale memory.
    return null;
  }
  return held.state;
}
