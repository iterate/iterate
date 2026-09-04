/**
 * Pinned-bug tests: the body asserts the DESIRED behavior, and while the bug
 * exists it must fail with an error matching the given pattern.
 *
 * `createFailing` registers the test through the runner's own expected-fail variant
 * — vitest spells it `test.fails`, playwright `test.fail` — so the pin is
 * native as far as reporting goes: it shows up in the "expected fail" summary
 * count, telemetry classifies it as expected-to-fail, and nothing downstream
 * needs to know the wrapper exists. The wrapper's only job is filtering WHICH
 * failure is allowed to satisfy that machinery.
 *
 * To use it, write a *normal* test body, and use a regex that you know the test (unfortunately) will fail with.
 *
 * ```ts
 * const fail = createFailing(test, /SAME-BOOT STALENESS/);
 * fail("a userspace facet rebuilds on a source commit", { timeout: 240_000 }, async () => {
 *   // asserts the DESIRED behavior; today it throws the matched error
 * });
 * ```
 *
 * Try to write normal-looking assertions - `expect` lets you pass in a custom message if you want to
 * tip the scales for a single assertion. Use "should" so you can write a truthful statement that remains
 * true even when the test *stops* failing (the system really should not run out of memory!).
 *
 * Three outcomes:
 * - body fails matching the pattern → the error is rethrown, the runner's
 *   expected-fail machinery is satisfied → green (the bug is still pinned)
 * - body fails with anything else → the wrapper logs the mismatch and returns
 *   SUCCESS, which the expected-fail machinery rejects → red. The runner's own
 *   message is generic ("Expect test to fail" / "passed unexpectedly"); the
 *   actual reason sits in the adjacent `[failing-test]` log line. A bare
 *   `test.fails` would have stayed silently green here — that is the whole
 *   point of the wrapper.
 * - body succeeds → same mechanism: logged, returned, red — with instructions
 *   to delete the wrapper, since the bug appears fixed.
 *
 * The native machinery has one blind spot: a failure that never passes
 * through the body — chiefly a runner-level test timeout on a hung body —
 * counts as the expected one. The wrapper therefore races the body against
 * its own 30s deadline and reports a timeout as NOT-the-pinned-failure (red),
 * so a hang cannot vanish into a vacuous pass. The default sits below every
 * test lane's runner timeout (apps/os unit: 45s; e2e: 120s) — it must, or the
 * runner fires first and the blind spot returns. A pin whose body
 * legitimately needs longer raises it via `options.timeoutMs`, still kept
 * BELOW the runner's own test timeout for the same reason.
 *
 * Write the body so the pinned bug produces a DISTINCTIVE error (throw a
 * purpose-built message rather than relying on a generic assertion diff), and
 * so that conditions which prove nothing — e.g. a coincidental restart that
 * masks the bug for one observation — retry or fail with a NON-matching
 * error instead of succeeding. See
 * apps/os/e2e/vitest/userspace-facet-source-version.e2e.test.ts for the
 * worked example (its predecessor bare `test.fails` false-alarmed 7+ times).
 */
export function createFailing<TestFn extends (...args: any[]) => any>(
  test: TestFn,
  failure: RegExp,
  options?: { timeoutMs: number },
): TestFn {
  const timeoutMs = options?.timeoutMs || 30_000;
  const failer: unknown = "fails" in test ? test.fails : "fail" in test ? test.fail : undefined;
  if (typeof failer !== "function") {
    throw new Error(
      "createFailing(test, pattern): test has neither .fails (vitest) nor .fail (playwright)",
    );
  }
  const register = (...args: any[]) => {
    const body = args.at(-1);
    if (typeof body !== "function") {
      throw new Error("createFailing(test, pattern): the last argument must be the test body");
    }
    // The body's own arguments pass through untouched — playwright fixtures
    // ({ page, ... }, testInfo), vitest context — whatever the wrapped test
    // function provides.
    const wrappedBody = async (...bodyArgs: any[]) => {
      (test as any).setTimeout?.(timeoutMs + 1000);
      // Race the body against the wrapper's own deadline: a hung body must
      // fail as NOT-the-pinned-failure rather than letting the runner's test
      // timeout fire, which the expected-fail machinery would count as the
      // pin holding.
      let timer: ReturnType<typeof setTimeout> | undefined;
      // `as const` on the kinds: without it each arm's `kind` widens to
      // `string`, the union stops discriminating, and `outcome.kind ===
      // "failed"` below would not narrow to expose `.error`.
      const outcome = await Promise.race([
        (async () => body(...bodyArgs))().then(
          () => ({ kind: "succeeded" as const }),
          (error: unknown) => ({ kind: "failed" as const, error }),
        ),
        new Promise<{ kind: "timed-out" }>((resolve) => {
          timer = setTimeout(() => resolve({ kind: "timed-out" }), timeoutMs);
        }),
      ]).finally(() => clearTimeout(timer));

      if (outcome.kind === "failed") {
        if (failure.test(String(outcome.error))) {
          throw outcome.error; // The ONLY throw allowed out: the pinned failure, which satisfies the runner's expected-fail machinery.
        }

        console.error(
          `[failing-test] Expected failure to match /${failure.source}/, got a different failure — ` +
            `this run proves nothing about the pinned bug:`,
          outcome.error,
        );
        return; // "success" here is what makes test.fails / test.fail go red
      }
      if (outcome.kind === "timed-out") {
        console.error(
          `[failing-test] The body is still running after ${timeoutMs}ms — a hang is not the ` +
            `pinned failure. Raise createFailing()'s options.timeoutMs (keeping it below the runner's ` +
            `test timeout) if the pin legitimately needs longer.`,
        );
        return; // same inversion: success → the expected-fail machinery goes red
      }
      console.error(
        `[failing-test] The test should have failed with /${failure.source}/ but it succeeded. ` +
          `If the pinned bug is fixed, delete the createFailing() wrapper and keep the body as a plain test.`,
      );
      // Fall through to success for the same reason as above.
    };

    // playwright and vitest look at function's source to see what's destructured into the test function, so fake that it looks like the original.
    Object.defineProperty(wrappedBody, "toString", { value: () => body.toString() });

    if ("setTimeout" in test) {
      // playwright-like, no `timeout` option, we set the timeout manually above
      return failer(...args.slice(0, -1), wrappedBody);
    } else {
      // vitest-like, we pass the timeout option to the test function. args.slice(1, -1) is either `[]` or `[{ ...otherOptions }]`
      // retry is pinned to zero: a suite-level `retry` re-runs the body on the
      // rethrown pinned failure (the retry fires before the `.fails`
      // inversion), so every pin would run twice per CI run and show up as
      // "(retry x1)" noise in retry telemetry — same pin as createFlake.
      const options = Object.assign({}, ...args.slice(1, -1), {
        timeout: timeoutMs + 1000,
        retry: 0,
      });
      return failer(args[0], options, wrappedBody);
    }
  };
  // The cast restates the contract the wrapper keeps by construction: it
  // forwards every argument unchanged except the trailing body, which it
  // replaces with a same-signature async body. No structural type can say
  // "the wrapped function, body semantics aside" — the runners' own test
  // types (vitest's overloads, playwright's fixture generics) are exactly
  // what callers need preserved, and TestFn is that type verbatim.
  return register as TestFn;
}

/**
 * Assert that a body fails for exactly the given reason — the standalone
 * sibling of {@link createFailing} for use INSIDE a plain test, where throwing (not
 * inverted success) is the right failure signal.
 */
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
      `If the pinned bug is fixed, delete the createFailing() wrapper and keep the body as a plain test.`,
  );
}
