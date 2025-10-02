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

export type Environment = "production" | "development" | "staging";

/**
 * Get the current environment type with smart handling of various formats.
 * Supports full names (production, development, staging) and abbreviations (PRD, DEV, STG).
 */
export function getNodeEnvironment(): Environment {
  const nodeEnv = process.env.NODE_ENV?.toLowerCase();
  // Handle NODE_ENV variations
  if (nodeEnv === "production" || nodeEnv === "prd") {
    return "production";
  }
  if (nodeEnv === "development" || nodeEnv === "dev") {
    return "development";
  }
  if (nodeEnv === "staging" || nodeEnv === "stg") {
    return "staging";
  }

  // Default to production if not specified
  return "production";
}

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

export function getBaseURL(
  params: { replaceLocalhostWithNgrok: boolean } = { replaceLocalhostWithNgrok: false },
) {
  const baseURL = process.env.VITE_PUBLIC_URL;
  if (!baseURL) {
    throw new Error("VITE_PUBLIC_URL is not set");
  }
  if (params.replaceLocalhostWithNgrok) {
    return replaceLocalhostWithNgrok(baseURL);
  }
  return baseURL;
}

// This function replaces localhost:5173 with the current iterate user's ngrok URL
export function replaceLocalhostWithNgrok(url: string): string {
  const iterateUser = process.env.ITERATE_USER;
  if (iterateUser && url.includes("localhost")) {
    return url
      .replace("localhost:5173", `${iterateUser}.dev.iterate.com`)
      .replace("http://", "https://");
  }
  return url;
}
