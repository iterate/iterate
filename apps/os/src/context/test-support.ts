// context/test-support.ts — what the context unit tests share.
import { vi } from "vitest";
import { InvokeHandle, type ItxExpression } from "iterate/expression";
import type { Caller } from "../caller.ts";
import type { ItxExpressionRewriteRule } from "./itx-expression-rewriting.ts";

/** Run `run` with every wait it takes elapsed at once: its answer or error, the warns it logged
 *  (`retries`: each platform-failure repeat and give-up of `retryPlatformFailures` logs one), and
 *  what it logged at info. */
export async function settle<T>(run: () => Promise<T>) {
  vi.useFakeTimers();
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const info = vi.spyOn(console, "info").mockImplementation(() => {});
  try {
    const outcome = run().then(
      (value) => ({ value }),
      (error: Error) => ({ error }),
    );
    await vi.runAllTimersAsync();
    return {
      ...(await outcome),
      retries: warn.mock.calls.map(([entry]) => entry),
      logs: info.mock.calls.map(([entry]) => entry),
    };
  } finally {
    warn.mockRestore();
    info.mockRestore();
    vi.useRealTimers();
  }
}

/** A resolver's reach beyond its own context (itx-expression-rewriting.ts `ItxExpressionResolver`),
 *  for a unit test of ONE context whose fakes stand in for its built-ins: every other context's
 *  table is empty, and a call that would run elsewhere is recorded in `located` and answers where
 *  it went. The Workers suite crosses real contexts (__workers-tests__/rule-snapshots.test.ts). */
export function oneContextReach(rulesOf: Record<string, ItxExpressionRewriteRule[]> = {}) {
  const located: { path: string; expression: ItxExpression; args: unknown[]; caller: Caller }[] =
    [];
  return {
    located,
    reach: {
      projectId: "prj_unit",
      snapshotOf: async (path: string) => ({ rules: rulesOf[path] || [], expiresAt: Infinity }),
      workersOf: (path: string) => ({
        get: (spec: unknown) => new InvokeHandle((steps) => ({ workersOf: path, spec, steps })),
      }),
      located: async (path: string, expression: ItxExpression, args: unknown[], caller: Caller) => {
        located.push({ path, expression, args, caller });
        return { locatedAt: path };
      },
    },
  };
}
