// HTTP routing to capabilities (spec §8): any cap whose surface includes
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
import type { FetchCallable } from "@iterate-com/shared/callable/types.ts";
import type { CapDescription } from "./protocol.ts";
import { getProjectDurableObjectName } from "~/domains/projects/durable-objects/project-durable-object.ts";
import { normalizeIngressHost } from "~/ingress/host-routing.ts";
import type { ExactHostIngressRule } from "~/ingress/types.ts";
import { normalizeProjectHostnameBase } from "~/lib/project-host-routing.ts";
import { authenticateAdminBearer } from "~/auth/admin.ts";
import { parseConfig } from "~/config.ts";

export const SHARE_TOKEN_PARAM = "itx_share";

/** Hostname → routing rule for cap hosts; null when the host isn't one. */
export async function getItxCapHostIngressRule(input: {
  bases: readonly string[];
  db: D1Database;
  host: string;
}): Promise<ExactHostIngressRule | null> {
  const host = normalizeIngressHost(input.host);

  for (const rawBase of input.bases) {
    const base = normalizeIngressHost(normalizeProjectHostnameBase(rawBase));
    if (host === base || !host.endsWith(`.${base}`)) continue;

    const prefix = host.slice(0, host.length - base.length - 1);
    if (prefix.includes(".")) continue;

    // Only the project-level form `{cap}--{project}` is implemented. The spec
    // also reserves `{cap}--{ctxId}--{project}` for child-context caps; that
    // routing isn't built yet, so we require EXACTLY two `--`-separated parts
    // and let any other shape fall through (fails closed → 404) rather than
    // mis-parsing `ctxId--project` as a project identifier.
    const parts = prefix.split("--");
    if (parts.length !== 2) continue;
    const [cap, projectIdentifier] = parts;
    if (!cap || !projectIdentifier) continue;

    const project = await input.db
      .prepare(`SELECT id FROM projects WHERE slug = ? OR id = ? LIMIT 1`)
      .bind(projectIdentifier, projectIdentifier)
      .first<{ id: string }>();
    if (!project) return null;

    const callable = {
      type: "fetch",
      via: {
        type: "loopback-binding",
        bindingType: "service",
        exportName: "ItxCapIngress",
        props: { cap, projectId: project.id },
      },
    } satisfies FetchCallable;

    return {
      id: `itx-cap-host:${project.id}:${cap}`,
      host,
      projectId: project.id,
      priority: 60,
      notes: "itx capability hostname",
      callable,
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    };
  }

  return null;
}

export type ItxCapIngressProps = {
  cap: string;
  projectId: string;
};

/**
 * The router target for cap hosts. Auth gate, then one registry dispatch:
 * itxInvoke({ name, path: ["fetch"], args: [request] }) — a members cap
 * exposes fetch() directly; a path-call cap sees { path: ["fetch"] } and can
 * implement HTTP however it likes.
 */
export class ItxCapIngress extends WorkerEntrypoint<Env, ItxCapIngressProps> {
  async fetch(request: Request): Promise<Response> {
    const props = (Reflect.get(this, "ctx") as ExecutionContext<ItxCapIngressProps>).props;
    const config = parseConfig(this.env);
    const project = this.env.PROJECT.getByName(getProjectDurableObjectName(props.projectId));

    // The host label was lowercased by normalizeIngressHost, but cap names
    // may contain uppercase — match case-insensitively so `myCap` is routable
    // at `mycap--{project}`. (Collisions that differ only by case are the
    // owner's problem; first exposed match wins.)
    const wanted = props.cap.toLowerCase();
    const caps = (await project.itxDescribe()) as CapDescription[];
    const cap = caps.find((candidate) => candidate.name.toLowerCase() === wanted);
    if (!cap || cap.meta.http?.expose !== true) {
      return new Response("Not Found", { status: 404 });
    }

    if (cap.meta.http.public !== true) {
      const authorized =
        authenticateAdminBearer({
          authorizationHeader: request.headers.get("authorization"),
          config,
        }) ||
        (await verifyShareToken({
          cap: cap.name,
          projectId: props.projectId,
          secret: config.adminApiSecret?.exposeSecret() ?? "",
          token: new URL(request.url).searchParams.get(SHARE_TOKEN_PARAM),
        }));
      if (!authorized) return new Response("Unauthorized", { status: 401 });
    }

    return (await project.itxInvoke({
      args: [request],
      // Use the registry's exact name, not the lowercased host label.
      name: cap.name,
      path: ["fetch"],
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
  cap: string;
  expiresAtMs: number;
  projectId: string;
  secret: string;
}): Promise<string> {
  const signature = await hmacSha256(
    input.secret,
    sharePayload({ cap: input.cap, expiresAtMs: input.expiresAtMs, projectId: input.projectId }),
  );
  return `${input.expiresAtMs}.${signature}`;
}

export async function verifyShareToken(input: {
  cap: string;
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
    sharePayload({ cap: input.cap, expiresAtMs, projectId: input.projectId }),
  );
  return timingSafeEqual(signature, expected);
}

function sharePayload(input: { cap: string; expiresAtMs: number; projectId: string }) {
  return `itx-share:${input.projectId}:${input.cap}:${input.expiresAtMs}`;
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
