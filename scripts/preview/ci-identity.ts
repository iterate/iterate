export type PreviewCiIdentity = {
  headSha: string;
  runId: string;
  runAttempt: string;
  slot: string;
};

/** A result or worker may only use the deployment from its own CI attempt. */
export function assertPreviewCiIdentity(expected: PreviewCiIdentity, actual: PreviewCiIdentity) {
  for (const key of ["headSha", "runId", "runAttempt", "slot"] as const) {
    if (actual[key] !== expected[key]) {
      throw new Error(
        `Preview CI identity mismatch: ${key} expected ${expected[key]}, received ${actual[key]}`,
      );
    }
  }
}
