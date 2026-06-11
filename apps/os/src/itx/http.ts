// HTTP routing to capabilities: any cap whose surface includes
// fetch(Request) is routable at its own hostname:
//
//     https://{cap}--{projectSlugOrId}.{projectHostnameBase}/…
//
// Subdomain-per-cap, never path-under-project-origin: agent-authored HTML on
// the project's main origin would be XSS into its cookies. Cap names are JS
// identifiers (no dashes), so the first `--` in the label is unambiguous.
// Project ingress itself is this same rule applied to cap #0: the config
// worker serves the bare project hostname.
//
// Routable ≠ public: the gate defaults to admin credentials, with two
// opt-ins set per cap — meta.http.public for "anyone", or a signed,
// expiring share URL for "let me show you something real quick".

import { WorkerEntrypoint } from "cloudflare:workers";
import { dialContext, projectContextAddress } from "./journal.ts";
import { authenticateAdminBearer } from "~/auth/admin.ts";
import { parseConfig } from "~/config.ts";

export const SHARE_TOKEN_PARAM = "itx_share";

export type ItxCapabilityIngressProps = {
  capability: string;
  projectId: string;
};

/**
 * The router target for cap hosts. Auth gate, then one core dispatch:
 * itx().invoke({ path: [...capPath, "fetch"], args: [request] }) — a members
 * cap exposes fetch() directly; a path-call cap sees { path: ["fetch"] } and
 * can implement HTTP however it likes.
 */
export class ItxCapabilityIngress extends WorkerEntrypoint<Env, ItxCapabilityIngressProps> {
  async fetch(request: Request): Promise<Response> {
    const props = this.ctx.props;
    const config = parseConfig(this.env);
    const node = dialContext(this.env, projectContextAddress(props.projectId));

    // The host label was lowercased by normalizeIngressHost, but cap names
    // may contain uppercase — match case-insensitively so `myCap` is routable
    // at `mycap--{project}`. (Collisions that differ only by case are the
    // owner's problem; first exposed match wins.)
    const wanted = props.capability.toLowerCase();
    const described = await node.itx().describe();
    const capability = described.find((candidate) => candidate.name.toLowerCase() === wanted);
    if (!capability || capability.meta.http?.expose !== true) {
      return new Response("Not Found", { status: 404 });
    }

    if (capability.meta.http.public !== true) {
      const authorized =
        authenticateAdminBearer({
          authorizationHeader: request.headers.get("authorization"),
          config,
        }) ||
        (await verifyShareToken({
          capability: capability.name,
          projectId: props.projectId,
          secret: config.adminApiSecret?.exposeSecret() ?? "",
          token: new URL(request.url).searchParams.get(SHARE_TOKEN_PARAM),
        }));
      if (!authorized) return new Response("Unauthorized", { status: 401 });
    }

    return (await node.itx().invoke({
      args: [request],
      // The core's exact name (not the lowercased host label) is the
      // dot-joined entry path; the full call path is entry path + "fetch".
      path: [...capability.name.split("."), "fetch"],
    })) as Response;
  }
}

// ---- share tokens -----------------------------------------------------------
//
// "Let me show you something real quick": a signed, expiring URL for one cap
// on one project. Format `${expiresAtMs}.${base64url(hmacSha256(payload))}`
// where payload = `itx-share:${projectId}:${cap}:${expiresAtMs}`. The admin
// API secret is the signing key — possession of a token grants exactly one
// cap's HTTP surface until expiry, nothing else.

export async function createShareToken(input: {
  capability: string;
  expiresAtMs: number;
  projectId: string;
  secret: string;
}): Promise<string> {
  const signature = await hmacSha256(
    input.secret,
    sharePayload({
      capability: input.capability,
      expiresAtMs: input.expiresAtMs,
      projectId: input.projectId,
    }),
  );
  return `${input.expiresAtMs}.${signature}`;
}

export async function verifyShareToken(input: {
  capability: string;
  projectId: string;
  secret: string;
  token: string | null;
}): Promise<boolean> {
  if (!input.token || !input.secret) return false;
  const [expiresPart, signature] = input.token.split(".");
  const expiresAtMs = Number(expiresPart);
  if (!Number.isFinite(expiresAtMs) || expiresAtMs < Date.now() || !signature) return false;
  const expected = await hmacSha256(
    input.secret,
    sharePayload({ capability: input.capability, expiresAtMs, projectId: input.projectId }),
  );
  return timingSafeEqual(signature, expected);
}

function sharePayload(input: { capability: string; expiresAtMs: number; projectId: string }) {
  return `itx-share:${input.projectId}:${input.capability}:${input.expiresAtMs}`;
}

async function hmacSha256(secret: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { hash: "SHA-256", name: "HMAC" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return btoa(String.fromCharCode(...new Uint8Array(signature)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let index = 0; index < a.length; index++) {
    mismatch |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }
  return mismatch === 0;
}
