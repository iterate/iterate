import type { AppConfig } from "~/config.ts";
import { authenticateAdminApiSecret } from "~/auth/admin.ts";
import { adminPrincipal } from "~/auth/principal.ts";

export const CAPNWEB_ADMIN_AUTH_COOKIE = "iterate-admin-auth";

type CookiePayload = {
  scopes?: unknown;
  secret: string;
};

export function authenticateCapnwebAdmin(input: { config: AppConfig; request: Request }) {
  const bearerPrincipal = authenticateAdminApiSecret({ config: input.config }, input.request);
  if (bearerPrincipal) return bearerPrincipal;

  const expectedSecret = input.config.adminApiSecret?.exposeSecret();
  const cookie = readCookie(input.request.headers.get("cookie"), CAPNWEB_ADMIN_AUTH_COOKIE);
  const payload = cookie ? decodeCookiePayload(cookie) : null;
  if (!expectedSecret || payload?.secret !== expectedSecret) return null;
  return adminPrincipal;
}

export async function handleCapnwebAdminCookieRequest(input: {
  config: AppConfig;
  request: Request;
}): Promise<Response> {
  const corsHeaders = capnwebCookieCorsHeaders(input.request);
  if (input.request.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const expectedSecret = input.config.adminApiSecret?.exposeSecret();
  const bearerPrincipal = authenticateAdminApiSecret({ config: input.config }, input.request);
  const bodySecret =
    input.request.method === "POST" && input.request.headers.get("content-type") === "text/plain"
      ? await input.request.text()
      : null;
  if (!expectedSecret || (!bearerPrincipal && bodySecret !== expectedSecret)) {
    return new Response("Unauthorized", { headers: corsHeaders, status: 401 });
  }

  const payload = encodeCookiePayload({
    scopes: { projects: "all" },
    secret: input.config.adminApiSecret!.exposeSecret(),
  });
  const url = new URL(input.request.url);
  const cookie = [
    `${CAPNWEB_ADMIN_AUTH_COOKIE}=${payload}`,
    "Path=/",
    "HttpOnly",
    "SameSite=None",
    url.protocol === "https:" ? "Secure" : "",
  ]
    .filter(Boolean)
    .join("; ");
  const headers = new Headers(corsHeaders);
  headers.set("set-cookie", cookie);
  return Response.json({ ok: true }, { headers });
}

function capnwebCookieCorsHeaders(request: Request) {
  const origin = request.headers.get("origin");
  return {
    "access-control-allow-credentials": "true",
    "access-control-allow-headers": "authorization, content-type",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-origin": origin ?? "*",
    vary: "origin",
  };
}

function encodeCookiePayload(payload: CookiePayload) {
  return btoa(JSON.stringify(payload)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function decodeCookiePayload(value: string): CookiePayload | null {
  try {
    const padded = value
      .replaceAll("-", "+")
      .replaceAll("_", "/")
      .padEnd(Math.ceil(value.length / 4) * 4, "=");
    const parsed = JSON.parse(atob(padded)) as unknown;
    return parsed && typeof parsed === "object" && "secret" in parsed
      ? (parsed as CookiePayload)
      : null;
  } catch {
    return null;
  }
}

function readCookie(cookieHeader: string | null, name: string) {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const [rawKey, ...rawValue] = part.trim().split("=");
    if (rawKey === name) return rawValue.join("=");
  }
  return null;
}
