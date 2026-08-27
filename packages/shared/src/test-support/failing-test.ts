/**
 * Pinned-bug tests: the body asserts the DESIRED behavior, and while the bug
 * exists it must fail with an error matching the given pattern.
 *
 * `failing` wraps any test-registering function — vitest's `test`,
 * playwright's `test`, their `.only`/`.skip` variants — and returns one with
 * the same shape, so fixtures, options objects, and timeouts pass straight
 * through:
 *
 * ```ts
 * const fail = failing(test, /SAME-BOOT STALENESS/);
 * fail("a userspace facet rebuilds on a source commit", { timeout: 240_000 }, async () => {
 *   // asserts the DESIRED behavior; today it throws the matched error
 * });
 * ```
 *
 * Three outcomes:
 * - body fails matching the pattern → the test passes (the bug is still pinned)
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
export function failing<TestFn extends (...args: any[]) => any>(
  test: TestFn,
  failure: RegExp,
): TestFn {
  const register = (...args: any[]) => {
    const body = args.at(-1);
    if (typeof body !== "function") {
      throw new Error("failing(test, pattern): the last argument must be the test body");
    }
    // The body's own arguments pass through untouched — playwright fixtures
    // ({ page, ... }, testInfo), vitest context — whatever the wrapped test
    // function provides.
    const wrapped = async (...bodyArgs: any[]) =>
      await expectFailure({ failure }, async () => await body(...bodyArgs));
    return test(...args.slice(0, -1), wrapped);
  };
  return register as TestFn;
}

/** The assertion core of {@link failing}, callable directly in unit tests. */
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
      `If the pinned bug is fixed, delete the failing() wrapper and keep the body as a plain test.`,
  );
}
