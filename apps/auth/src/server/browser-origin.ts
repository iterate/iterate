export const ITERATE_BROWSER_EXTENSION_ORIGIN =
  "chrome-extension://miplldbnkopaghnkiebdkefnmokobeco";

/**
 * THE browser-origin trust decision, in one place. Loopback origins: on
 * test-automation stages (fixedTestOtpEnabled — local/dev/preview, never
 * production) ANY loopback port is trusted, because the Expo Web mobile app's
 * browser-side OAuth runs on a random port per invocation. Production trusts
 * only the MCP inspector's fixed port 6274. The stable Iterate browser
 * extension origin is also trusted. Everything else must be this deployment:
 * the auth app origin or its public alias.
 *
 * Returns the exact origin CORS and better-auth should trust, or rejects it.
 */
export function resolveAllowedBrowserOrigin(
  origin: string | null | undefined,
  policy: {
    authAppOrigin: string;
    publicUrl?: string;
    fixedTestOtpEnabled: boolean;
  },
) {
  if (!origin || !URL.canParse(origin)) return null;

  // WHATWG URL reports a `null` origin for extension schemes. Preserve the
  // exact stable extension origin so better-auth can compare the Origin
  // header instead of accidentally trusting or returning the string "null".
  if (origin.startsWith("chrome-extension:")) {
    return origin === ITERATE_BROWSER_EXTENSION_ORIGIN ? origin : null;
  }

  const url = new URL(origin);
  const normalizedOrigin = url.origin;
  const isLoopback =
    url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (isLoopback) {
    return policy.fixedTestOtpEnabled || url.port === "6274" ? normalizedOrigin : null;
  }
  if (normalizedOrigin === policy.authAppOrigin || normalizedOrigin === policy.publicUrl) {
    return normalizedOrigin;
  }
  return null;
}
