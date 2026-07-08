// ITX expressions: a persisted name for a capability, as plain data.
//
// An expression is a walk from an itx root to a value: string steps are
// property reads, `[method, ...args]` steps are calls. Persisting one is
// persisting the NAME of a capability, never its authority — every evaluation
// re-derives authority from the root it is handed at that moment (a capability
// mount evaluates against the capability host's itx; a stream's push
// subscription evaluates against an `env.ITX`-scoped root). Deleting the
// stored expression is revocation, because the store is the only holder.
//
// Consumers today: capability-host mounts (`type: "itx-expression"` records),
// stream push subscriptions (`delivery: { mode: "push", expression }`), and
// agent birth mounts. One shape, one evaluator, one zod schema — defined here,
// at the leaf, so domain contracts can share them without import cycles.

import { z } from "zod";

/** One step of an {@link ItxExpression}: a property read, or a `[method, ...args]` call. */
export type ItxExpressionStep = string | [method: string, ...args: unknown[]];

/** A persisted capability name: the steps from an itx root to a value. */
export type ItxExpression = ItxExpressionStep[];

/** Zod schema for one expression step; merges with the type of the same name. */
export const ItxExpressionStep: z.ZodType<ItxExpressionStep> = z.union([
  z.string(),
  z
    .array(z.unknown())
    .refine((step): step is [string, ...unknown[]] => typeof step[0] === "string", {
      message: "call expression steps must start with a method name",
    }),
]);

/** Zod schema for a whole expression (at least one step); merges with the type of the same name. */
export const ItxExpression: z.ZodType<ItxExpression> = z.array(ItxExpressionStep).min(1);

export type EvaluatedItxExpression = {
  /**
   * The object the final value was read off, when the last step was a property
   * read — so a caller invoking the value as a function can preserve `this`.
   * `undefined` after a call step (the call already consumed its receiver).
   */
  receiver: unknown;
  value: unknown;
};

/**
 * Walks `expression` from `root`. Works identically over local objects and RPC
 * stubs: property reads on a stub yield pipelined stubs, call steps invoke —
 * exactly the traffic ordinary `itx.streams.get(path).append(...)` user code
 * produces, so evaluating a stored expression is never a special lane.
 */
export async function evaluateItxExpression(
  root: unknown,
  expression: ItxExpression,
): Promise<EvaluatedItxExpression> {
  assertItxExpression(expression);

  let value = root;
  let receiver: unknown;
  for (const step of expression) {
    if (typeof step === "string") {
      const target = await value;
      assertObjectLike(target, step);
      receiver = target;
      value = Reflect.get(target, step);
      continue;
    }

    const [method, ...args] = step;
    const target = await value;
    assertObjectLike(target, method);
    const handler = Reflect.get(target, method);
    if (typeof handler !== "function") {
      throw new Error(`ITX expression method "${method}" did not resolve to a function`);
    }
    receiver = undefined;
    value = Reflect.apply(handler, target, args);
  }

  return { receiver, value: await value };
}

/** Structural validation of an expression (shape only, no evaluation). */
export function assertItxExpression(expression: ItxExpression): void {
  if (!Array.isArray(expression) || expression.length === 0) {
    throw new Error("ITX expression must contain at least one step");
  }

  for (const step of expression) {
    if (typeof step === "string") continue;
    if (Array.isArray(step) && typeof step[0] === "string") continue;
    throw new Error(`invalid ITX expression step ${JSON.stringify(step)}`);
  }
}

function assertObjectLike(value: unknown, segment: string): asserts value is object | Function {
  if (!isObjectLike(value)) {
    throw new Error(`ITX expression segment "${segment}" hit ${String(value)}`);
  }
}

function isObjectLike(value: unknown): value is object | Function {
  return (typeof value === "object" && value !== null) || typeof value === "function";
}
