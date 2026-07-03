import { getOsResourceBases } from "./oauth-resources.ts";

const LOCAL_DEVELOPMENT_REDIRECT_ORIGINS = [
  "http://localhost:5173",
  "http://localhost:5183",
  "http://localhost:7101",
  "http://localhost:7201",
];

const EXAMPLE_APP_REDIRECT_ORIGINS = ["https://auth-example.iterate.app"];

export function resolveAuthLogoutReturnTo(input: {
  rawReturnTo: string | null | undefined;
  authOrigin: string;
  publicOrigin?: string | null;
}) {
  const fallback = input.publicOrigin ?? input.authOrigin;
  if (!input.rawReturnTo) return fallback;

  let parsed: URL;
  try {
    parsed = new URL(input.rawReturnTo);
  } catch {
    return fallback;
  }

  const allowedOrigins = new Set([
    input.authOrigin,
    ...(input.publicOrigin ? [input.publicOrigin] : []),
    ...getOsResourceBases(),
    ...EXAMPLE_APP_REDIRECT_ORIGINS,
    ...LOCAL_DEVELOPMENT_REDIRECT_ORIGINS,
  ]);

  return allowedOrigins.has(parsed.origin) ? parsed.toString() : fallback;
}

// Copy Set-Cookie headers individually — Headers.get("set-cookie") would
// comma-join multiple cookies into one invalid header. getSetCookie() exists
// in every runtime this code runs in (workerd and Node 20+).
// https://developers.cloudflare.com/workers/runtime-apis/headers/
export function appendSetCookieHeaders(target: Headers, source: Headers) {
  for (const cookie of source.getSetCookie()) {
    target.append("set-cookie", cookie);
  }
}
