/**
 * Try to parse a value as JSON, returning the original value if parsing fails.
 */
export function tryParseJSON(value: unknown): unknown {
  try {
    return JSON.parse(value as string);
  } catch (_error) {
    return value;
  }
}

/**
 * Exhaustive match guard for TypeScript switch statements.
 * Throws an error if called, which should only happen if a case is not handled.
 */
export function ensureString(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  return JSON.stringify(value);
}

export type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

export function getEnvironmentName(env: {
  ITERATE_USER: string;
  STAGE__PR_ID?: string;
  ESTATE_NAME: string;
}) {
  const { STAGE__PR_ID, ITERATE_USER, ESTATE_NAME } = env;
  if (STAGE__PR_ID) {
    return `pr-${STAGE__PR_ID}`;
  }
  const isDev = !!ITERATE_USER;
  return isDev ? `local-${ITERATE_USER}` : `estate-${ESTATE_NAME}`;
}
