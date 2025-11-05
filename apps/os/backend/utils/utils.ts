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
