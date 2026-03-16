import { typeid as createTypeId } from "typeid-js";

export interface TypeIdEnv {
  TYPEID_PREFIX: string;
}

function normalizePrefix(value: string, fieldName: "TYPEID_PREFIX" | "prefix") {
  const normalized = value.trim().replace(/_+$/g, "");

  if (!normalized) {
    throw new Error(`${fieldName} is required`);
  }

  if (!/^[a-z]+$/.test(normalized)) {
    throw new Error(`${fieldName} must contain lowercase letters only`);
  }

  return normalized;
}

export function typeid<TEnv extends TypeIdEnv, TPrefix extends string>(params: {
  env: TEnv;
  prefix: TPrefix;
}): `${string}_${string}` {
  // We call the official TypeID implementation directly:
  // https://github.com/jetify-com/typeid-js
  //
  // All environments should set TYPEID_PREFIX so generated ids always encode
  // their environment context and we never confuse ids across env boundaries.
  const globalPrefix = normalizePrefix(params.env.TYPEID_PREFIX, "TYPEID_PREFIX");
  const localPrefix = normalizePrefix(params.prefix, "prefix");

  return createTypeId(`${globalPrefix}${localPrefix}`).toString() as `${string}_${string}`;
}
