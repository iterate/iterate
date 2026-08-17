import { evaluateItxExpression, type EvaluatedItxExpression } from "../../itx/expression.ts";
import { invokeFlattenedPath } from "./live-capability.ts";

// The evaluator itself lives at the itx leaf (src/itx/expression.ts) so stream
// ITX-expression stream receivers share it; this module keeps the capability-host-specific
// halves: normalizing an evaluated expression into a provider and invoking it.
export { evaluateItxExpression };

type NormalizedCapabilityProvider = {
  capability: unknown;
  flattenNestedPath: boolean;
  receiver: unknown;
};

export async function normalizeCapabilityProvider(
  evaluated: EvaluatedItxExpression,
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

function assertObjectLike(value: unknown, segment: string): asserts value is object | Function {
  if (!isObjectLike(value)) {
    throw new Error(`itx expression segment "${segment}" hit ${String(value)}`);
  }
}

function isObjectLike(value: unknown): value is object | Function {
  return (typeof value === "object" && value !== null) || typeof value === "function";
}
