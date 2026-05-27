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

export function appendSetCookieHeaders(target: Headers, source: Headers) {
  const getSetCookie = (source as Headers & { getSetCookie?: () => string[] }).getSetCookie;
  const cookies = getSetCookie?.call(source) ?? [];
  if (cookies.length > 0) {
    for (const cookie of cookies) {
      target.append("set-cookie", cookie);
    }
    return;
  }

  const setCookie = source.get("set-cookie");
  if (setCookie) {
    target.append("set-cookie", setCookie);
  }
}
