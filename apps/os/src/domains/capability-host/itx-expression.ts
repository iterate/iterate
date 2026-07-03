import type { ItxExpression } from "../../types.ts";
import { invokeFlattenedPath } from "./live-capability.ts";

type EvaluatedExpression = {
  receiver: unknown;
  value: unknown;
};

type NormalizedCapabilityProvider = {
  capability: unknown;
  flattenNestedPath: boolean;
  receiver: unknown;
};

export async function evaluateItxExpression(
  root: unknown,
  expression: ItxExpression,
): Promise<EvaluatedExpression> {
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

export async function normalizeCapabilityProvider(
  evaluated: EvaluatedExpression,
  overrides: {
    flattenNestedPaths?: boolean;
  } = {},
): Promise<NormalizedCapabilityProvider> {
  const value = await evaluated.value;
  const overrideFlattenNestedPath =
    Object.hasOwn(overrides, "flattenNestedPaths") && overrides.flattenNestedPaths === true;

  return {
    capability: value,
    flattenNestedPath: overrideFlattenNestedPath,
    receiver: evaluated.receiver,
  };
}

export async function invokeNormalizedCapability(
  provider: NormalizedCapabilityProvider,
  path: string[],
  args: unknown[],
) {
  if (provider.flattenNestedPath) {
    return await invokeFlattenedPath({ args, path, target: provider.capability });
  }

  return await replayProviderPath({
    args,
    path,
    receiver: provider.receiver,
    target: provider.capability,
  });
}

async function replayProviderPath({
  args,
  path,
  receiver,
  target,
}: {
  args: unknown[];
  path: string[];
  receiver: unknown;
  target: unknown;
}) {
  const root = await target;
  if (path.length === 0) {
    return typeof root === "function" ? await Reflect.apply(root, receiver, args) : root;
  }

  let current = root;
  for (let i = 0; i < path.length - 1; i++) {
    assertObjectLike(current, path[i]);
    current = await Reflect.get(current, path[i]);
  }

  const method = path.at(-1)!;
  assertObjectLike(current, method);
  const handler = Reflect.get(current, method);
  if (typeof handler !== "function") {
    throw new Error(`capability path "${path.join(".")}" did not resolve to a function`);
  }
  return await Reflect.apply(handler, current, args);
}

function assertItxExpression(expression: ItxExpression): void {
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
