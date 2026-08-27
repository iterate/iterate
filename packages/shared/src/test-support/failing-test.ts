import { test } from "vitest";

/**
 * A pinned-bug test: the body asserts the DESIRED behavior, and while the bug
 * exists it must fail with an error matching `failure`. Three outcomes:
 *
 * - body fails matching `failure` → the test passes (the bug is still pinned)
 * - body fails with anything else → the test fails, naming both errors — this
 *   is what a bare `test.fails` cannot do: there, a body that starts failing
 *   for an unrelated reason (infra, typo) stays silently green and the pin
 *   stops pinning anything
 * - body succeeds → the test fails with instructions to delete the wrapper —
 *   the bug appears fixed, so the body should become a plain test
 *
 * Write the body so the pinned bug produces a DISTINCTIVE error (throw a
 * purpose-built message rather than relying on a generic assertion diff), and
 * so that conditions which prove nothing — e.g. a coincidental restart that
 * masks the bug for one observation — retry or fail with a NON-matching
 * error instead of succeeding. See
 * apps/os/e2e/vitest/userspace-facet-source-version.e2e.test.ts for the
 * worked example (its predecessor `test.fails` false-alarmed 7+ times).
 */
export function failingTest(
  options: { failure: RegExp; timeout?: number },
  name: string,
  body: () => Promise<unknown>,
) {
  test(
    name,
    options.timeout === undefined ? {} : { timeout: options.timeout },
    async () => await expectFailure(options, body),
  );
}

/** The assertion core of {@link failingTest}, callable directly in unit tests. */
export async function expectFailure(options: { failure: RegExp }, body: () => Promise<unknown>) {
  try {
    await body();
  } catch (error) {
    if (!options.failure.test(String(error))) {
      throw new Error(`Expected failure to match /${options.failure.source}/, got: ${error}`, {
        cause: error,
      });
    }
    return; // failed for exactly the pinned reason — the bug is still present
  }
  // Deliberately outside the try: this throw must never be caught above and
  // mistaken for a candidate failure.
  throw new Error(
    `The test should have failed with /${options.failure.source}/ but it succeeded. ` +
      `If the pinned bug is fixed, delete the failingTest wrapper and keep the body as a plain test.`,
  );
}
