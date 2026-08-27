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
      expectFailure({ failure }, async () => await body(...bodyArgs));
    // Playwright and vitest's test.extend decide WHICH fixtures to set up by
    // parsing the test function's source for its destructured first
    // parameter. A rest-args wrapper would hide the body's fixture names and
    // the runner would instantiate none of them — so present the body's own
    // source when the runner looks.
    Object.defineProperty(wrapped, "toString", { value: () => body.toString() });
    return test(...args.slice(0, -1), wrapped);
  };
  // The cast restates the contract the wrapper keeps by construction: it
  // forwards every argument unchanged except the trailing body, which it
  // replaces with a same-signature async body. No structural type can say
  // "the wrapped function, body semantics aside" — the runners' own test
  // types (vitest's overloads, playwright's fixture generics) are exactly
  // what callers need preserved, and TestFn is that type verbatim.
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
