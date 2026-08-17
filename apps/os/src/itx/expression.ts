// itx expressions: a persisted name for a capability, as plain data.
//
// An expression is a walk from an itx root to a value: string steps are
// property reads, `[method, ...args]` steps are calls. Persisting one is
// persisting the NAME of a capability, never its authority — every evaluation
// re-derives authority from the root it is handed at that moment (a capability
// mount evaluates against the capability host's itx; an ITX-expression stream
// receiver evaluates against an `env.ITX`-scoped root). Deleting the
// stored expression is revocation, because the store is the only holder.
//
// Consumers today: capability-host mounts (`type: "itx-call"` records),
// stream receivers addressed by `expression`, and
// agent birth mounts. One shape, one evaluator, one zod schema — defined here,
// at the leaf, so domain contracts can share them without import cycles.

import { RpcTarget } from "capnweb";
import { z } from "zod";

/** One step of an {@link ItxExpression}: a property read, or a `[method, ...args]` call. */
export type ItxExpressionStep = string | [method: string, ...args: unknown[]];

/** A persisted capability name: the steps from an itx root to a value. */
export type ItxExpression = ItxExpressionStep[];

const RESERVED_ITX_PROPERTY_NAMES = new Set(["__proto__", "constructor", "prototype"]);

function reservedItxPropertyName(step: ItxExpressionStep): string | undefined {
  const propertyName = typeof step === "string" ? step : step[0];
  return RESERVED_ITX_PROPERTY_NAMES.has(propertyName) ? propertyName : undefined;
}

/** Zod schema for one expression step; merges with the type of the same name. */
export const ItxExpressionStep: z.ZodType<ItxExpressionStep> = z
  .union([
    z.string(),
    z
      .array(z.unknown())
      .refine((step): step is [string, ...unknown[]] => typeof step[0] === "string", {
        message: "call expression steps must start with a method name",
      }),
  ])
  .superRefine((step, context) => {
    const reserved = reservedItxPropertyName(step);
    if (reserved === undefined) return;
    context.addIssue({
      code: "custom",
      message: `itx expressions cannot use reserved property name "${reserved}"`,
    });
  });

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
 *
 * STUB HYGIENE: each awaited step over an RPC transport materializes a
 * client-side stub, and every one except the final value (and its receiver,
 * kept for `this`-preserving invocation) is an INTERMEDIATE this walk owns —
 * `["agents", ["get", path], "processor", [...]]` materializes the agent
 * collection, the agent, and the processor relay on the way to the answer.
 * Dropping them un-disposed leaves reclamation to the GC, which workerd
 * rightly warns about on every collection ("An RPC stub was not disposed
 * properly") — at one stream-delivery dial per agent birth that is steady
 * observability logspam. Disposing an intermediate releases only ITS export;
 * values already obtained through it (including the final one) hold their
 * own exports and survive — the same end state late GC produced, made
 * deterministic and silent. In-process evaluation is untouched BY
 * CONSTRUCTION, not just in practice: local targets are `instanceof
 * RpcTarget` (every itx surface extends it) and the walk only disposes
 * awaited values that are NOT — i.e. genuine client-side transport stubs.
 * That gate matters: some local targets carry a REAL `Symbol.dispose`
 * (CapabilityProvisionRpcTarget's revokes the mount), which an ungated sweep
 * would invoke.
 */
export async function evaluateItxExpression(
  root: unknown,
  expression: ItxExpression,
): Promise<EvaluatedItxExpression> {
  assertItxExpression(expression);

  const materialized: object[] = [];
  const materialize = async (pending: unknown): Promise<unknown> => {
    const target = await pending;
    if (
      isObjectLike(target) &&
      target !== root &&
      !(target instanceof RpcTarget) &&
      !materialized.includes(target)
    ) {
      materialized.push(target);
    }
    return target;
  };
  const disposeIntermediates = (keep: unknown[]) => {
    for (const target of materialized) {
      if (keep.includes(target)) continue;
      (target as Partial<Disposable>)[Symbol.dispose]?.();
    }
  };

  try {
    let value = root;
    let receiver: unknown;
    for (const step of expression) {
      if (typeof step === "string") {
        const target = await materialize(value);
        assertObjectLike(target, step);
        receiver = target;
        value = Reflect.get(target, step);
        continue;
      }

      const [method, ...args] = step;
      const target = await materialize(value);
      assertObjectLike(target, method);
      const handler = Reflect.get(target, method);
      if (typeof handler !== "function") {
        throw new Error(`itx expression method "${method}" did not resolve to a function`);
      }
      receiver = undefined;
      value = Reflect.apply(handler, target, args);
    }

    const finalValue = await value;
    disposeIntermediates([finalValue, receiver]);
    return { receiver, value: finalValue };
  } catch (error) {
    // The failed walk owns everything it materialized — release it all. The
    // root itself is caller-owned and deliberately excluded above.
    disposeIntermediates([]);
    throw error;
  }
}

/** Structural validation of an expression (shape only, no evaluation). */
function assertItxExpression(expression: ItxExpression): void {
  if (!Array.isArray(expression) || expression.length === 0) {
    throw new Error("itx expression must contain at least one step");
  }

  for (const step of expression) {
    if (!(typeof step === "string" || (Array.isArray(step) && typeof step[0] === "string"))) {
      throw new Error(`invalid itx expression step ${JSON.stringify(step)}`);
    }
    const reserved = reservedItxPropertyName(step);
    if (reserved !== undefined) {
      throw new Error(`itx expression cannot use reserved property name "${reserved}"`);
    }
  }
}

function assertObjectLike(value: unknown, segment: string): asserts value is object | Function {
  if (!isObjectLike(value)) {
    throw new Error(`itx expression segment "${segment}" hit ${String(value)}`);
  }
}

function isObjectLike(value: unknown): value is object | Function {
  return (typeof value === "object" && value !== null) || typeof value === "function";
}
