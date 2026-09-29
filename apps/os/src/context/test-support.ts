// context/test-support.ts — what the context unit tests share.
import { vi } from "vitest";
import {
  InvokeHandle,
  parse,
  parseItxExpressionPrefix,
  type ItxExpression,
} from "iterate/expression";
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

/** When a live snapshot expires: never within a test, and finite, as a refusal's `validUntil`. */
export const FAR = 8.64e15;

/** `"match ⇒ target — description"`: `null` a mask; a target may hold holes (`@`). */
export function rule(spelled: string): ItxExpressionRewriteRule {
  const [, match, target, description] = /^(.+?) ⇒ (.+?)(?: — (.+?))?$/.exec(spelled)!;
  return {
    match: parseItxExpressionPrefix(match!),
    target: target === "null" ? null : parse(target!, { holes: true }),
    description,
  };
}

/** One context's reach: every other context's table is `rulesOf[path]` (the first `expiredReads`
 *  snapshots already expired), and a call that would run elsewhere is recorded and answers where. */
export function oneContextReach({
  rulesOf = {},
  expiredReads = 0,
}: { rulesOf?: Record<string, ItxExpressionRewriteRule[]>; expiredReads?: number } = {}) {
  const located: { path: string; expression: ItxExpression; args: unknown[]; caller: Caller }[] =
    [];
  const snapshotsRead: string[] = [];
  return {
    located,
    snapshotsRead,
    reach: {
      projectId: "prj_unit",
      recordLoopLimit: () => {},
      snapshotOf: async (path: string) => {
        snapshotsRead.push(path);
        const expired = snapshotsRead.length <= expiredReads;
        return { rules: rulesOf[path] || [], expiresAt: expired ? Date.now() - 1 : FAR };
      },
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
