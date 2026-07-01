import type {
  CapabilityDescriptionMetadata,
  CapabilityPackage,
  ItxExpression,
} from "../../types.ts";
import { invokeFlattenedPath } from "./live-capability.ts";

type EvaluatedExpression = {
  receiver: unknown;
  value: unknown;
};

type NormalizedCapabilityProvider = {
  capability: unknown;
  flattenNestedPath: boolean;
  instructions?: string;
  receiver: unknown;
  types?: string;
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
    instructions?: string;
    types?: string;
  } = {},
): Promise<NormalizedCapabilityProvider> {
  const value = await evaluated.value;
  const overrideFlattenNestedPath = ownValue(overrides, "flattenNestedPaths") === true;
  const overrideInstructions = ownString(overrides, "instructions");
  const overrideTypes = ownString(overrides, "types");

  if (isCapabilityPackage(value)) {
    const packageFlattenNestedPath = ownValue(value, "flattenNestedPaths") === true;
    return {
      capability: value.capability,
      flattenNestedPath: overrideFlattenNestedPath || packageFlattenNestedPath,
      instructions: overrideInstructions ?? ownString(value, "instructions"),
      receiver: undefined,
      types: overrideTypes ?? ownString(value, "types"),
    };
  }

  return {
    capability: value,
    flattenNestedPath: overrideFlattenNestedPath,
    instructions: overrideInstructions,
    receiver: evaluated.receiver,
    types: overrideTypes,
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

export async function describeKnownBuiltinExpression(
  expression: ItxExpression,
  provider: NormalizedCapabilityProvider,
): Promise<CapabilityDescriptionMetadata | undefined> {
  if (!isKnownDescribedBuiltinExpression(expression)) return undefined;

  const target = await provider.capability;
  if (!isObjectLike(target)) return undefined;
  if (!("__describe" in target)) return undefined;

  const describe = Reflect.get(target, "__describe");
  if (typeof describe !== "function") return undefined;
  return (await Reflect.apply(describe, target, [])) as CapabilityDescriptionMetadata;
}

function isKnownDescribedBuiltinExpression(expression: ItxExpression): boolean {
  if (expression.length !== 2) return false;
  const [root, connect] = expression;
  return (
    (root === "mcp" || root === "openapi") && Array.isArray(connect) && connect[0] === "connect"
  );
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

function isCapabilityPackage(value: unknown): value is CapabilityPackage {
  return (
    typeof value === "object" &&
    value !== null &&
    Object.hasOwn(value, "capability") &&
    (Object.hasOwn(value, "instructions") ||
      Object.hasOwn(value, "types") ||
      Object.hasOwn(value, "flattenNestedPaths"))
  );
}

function ownValue<T extends object, K extends PropertyKey>(value: T, key: K): unknown {
  return Object.hasOwn(value, key) ? Reflect.get(value, key) : undefined;
}

function ownString<T extends object, K extends PropertyKey>(value: T, key: K): string | undefined {
  const result = ownValue(value, key);
  return typeof result === "string" ? result : undefined;
}

function assertObjectLike(value: unknown, segment: string): asserts value is object | Function {
  if (!isObjectLike(value)) {
    throw new Error(`ITX expression segment "${segment}" hit ${String(value)}`);
  }
}

function isObjectLike(value: unknown): value is object | Function {
  return (typeof value === "object" && value !== null) || typeof value === "function";
}
