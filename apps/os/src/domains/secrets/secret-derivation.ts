// Derived secrets — the unifying theory.
//
// A Secret's material is either a FACT (set directly: a password, a refresh
// token, a PAT, a plain config variable) or DERIVED: computed from the
// material of OTHER secrets via an exchange, valid for a while, recomputed on
// demand. OAuth access tokens are not special — "POST the token endpoint with
// getSecret({ key: "google/refresh-token" }) and getSecret({ key:
// "google/oauth-client-secret" }), read access_token and expires_in" is just
// one http-exchange derivation. So is "exchange my Waitrose username/password
// for a 5-minute session token".
//
// The derivation request template speaks the SAME placeholder language as
// project egress (`getSecret({ key: "..." })`) — derivation IS egress
// substitution, one hop further down, performed by the secret system itself.
// Because resolving a referenced key goes through that secret's own DO (which
// ensures freshness first), derivations CHAIN: a token derived from a token
// derived from a password, each hop audited.
//
// This module is the pure half (no cloudflare:workers) so Node tests can
// exercise it; the Secret Durable Object owns when to run it (inline on use
// when stale, proactively via alarm) and journals each run as secret/rotated.

import { z } from "zod";

export const HttpExchangeDerivation = z.object({
  kind: z.literal("http-exchange"),
  request: z.object({
    url: z.string(),
    method: z.string().default("POST"),
    headers: z.record(z.string(), z.string()).optional(),
    /** May contain getSecret({ key: "..." }) references, like url and headers. */
    body: z.string().optional(),
  }),
  extract: z.object({
    /** JSON pointer to the new material in the response body, e.g. "/access_token". */
    materialPointer: z.string(),
    /** JSON pointer to a seconds-until-expiry number, e.g. "/expires_in". */
    expiresInPointer: z.string().optional(),
    /** Fixed ttl for APIs that don't return one (e.g. a 5-minute session token). */
    ttlSeconds: z.number().optional(),
  }),
  refreshLeewaySeconds: z.number().default(30),
});
export type HttpExchangeDerivation = z.infer<typeof HttpExchangeDerivation>;

/** The fully general escape hatch: project-provided code (a dynamic worker /
 * itx-addressable function) computes { material, expiresAt } from source
 * secrets. Declared so journals can carry it; execution is not wired in the
 * spike. */
export const ScriptDerivation = z.object({
  kind: z.literal("script"),
  /** itx capability path on the project's own worker, e.g. "worker.deriveWaitroseToken". */
  capabilityPath: z.string(),
  refreshLeewaySeconds: z.number().default(30),
});
export type ScriptDerivation = z.infer<typeof ScriptDerivation>;

export const SecretDerivation = z.discriminatedUnion("kind", [
  HttpExchangeDerivation,
  ScriptDerivation,
]);
export type SecretDerivation = z.infer<typeof SecretDerivation>;

/** Matches the egress placeholder convention (egress-secret-substitution.ts):
 * getSecret({ key: "some/slug" }), whitespace-insensitive, single or double
 * quotes — INCLUDING backslash-escaped quotes, because derivation templates
 * routinely embed placeholders inside JSON.stringify'd request bodies. */
const SECRET_KEY_REFERENCE = /getSecret\(\s*\{\s*key\s*:\s*\\?(["'])([^"'\\]+)\\?\1\s*\}\s*\)/g;

export function parseSecretKeyReferences(text: string): string[] {
  return [...text.matchAll(SECRET_KEY_REFERENCE)].map((match) => match[2]!);
}

export async function substituteSecretKeyReferences(
  text: string,
  resolve: (key: string) => Promise<string>,
): Promise<string> {
  const keys = [...new Set(parseSecretKeyReferences(text))];
  const materials = new Map(
    await Promise.all(keys.map(async (key) => [key, await resolve(key)] as const)),
  );
  return text.replace(SECRET_KEY_REFERENCE, (_match, _quote, key: string) => materials.get(key)!);
}

/**
 * SELECTIVE substitution: replace only the references `resolve` knows
 * (non-null), leave the rest verbatim. This is what lets a request pass
 * through a CHAIN of substitution hops — each Secret DO replaces its own
 * reference and forwards the request, placeholders for later hops intact.
 * Deliberately does not re-parse its own output, so substituted material can
 * never inject new references.
 */
export function substituteKnownSecretKeyReferences(
  text: string,
  resolve: (key: string) => string | null,
): string {
  return text.replace(SECRET_KEY_REFERENCE, (match, _quote, key: string) => {
    return resolve(key) ?? match;
  });
}

export async function deriveViaHttpExchange(input: {
  derivation: HttpExchangeDerivation;
  resolveSecretKey(key: string): Promise<string>;
  fetchImpl?: typeof fetch;
  nowMs: number;
}): Promise<{ material: string; expiresAt?: string }> {
  const { derivation, resolveSecretKey } = input;
  const substitute = (text: string) => substituteSecretKeyReferences(text, resolveSecretKey);

  const response = await (input.fetchImpl ?? fetch)(await substitute(derivation.request.url), {
    method: derivation.request.method,
    headers: Object.fromEntries(
      await Promise.all(
        Object.entries(derivation.request.headers ?? {}).map(
          async ([name, value]) => [name, await substitute(value)] as const,
        ),
      ),
    ),
    ...(derivation.request.body == null ? {} : { body: await substitute(derivation.request.body) }),
  });
  const responseBody = (await response.json()) as unknown;
  if (!response.ok) {
    throw new Error(
      `Secret derivation exchange failed: HTTP ${response.status} from ${derivation.request.url}.`,
    );
  }

  const material = jsonPointerGet(responseBody, derivation.extract.materialPointer);
  if (typeof material !== "string" || material.length === 0) {
    throw new Error(
      `Secret derivation extracted no material at ${derivation.extract.materialPointer}.`,
    );
  }

  let ttlSeconds = derivation.extract.ttlSeconds;
  if (derivation.extract.expiresInPointer != null) {
    const expiresIn = jsonPointerGet(responseBody, derivation.extract.expiresInPointer);
    if (typeof expiresIn === "number") ttlSeconds = expiresIn;
  }

  return {
    material,
    ...(ttlSeconds == null
      ? {}
      : { expiresAt: new Date(input.nowMs + ttlSeconds * 1000).toISOString() }),
  };
}

/** Stale = no material at all, or within leeway of (or past) expiry. Material
 * without an expiresAt never goes stale on its own. */
export function materialIsStale(input: {
  hasMaterial: boolean;
  expiresAt?: string;
  leewaySeconds: number;
  nowMs: number;
}): boolean {
  if (!input.hasMaterial) return true;
  if (input.expiresAt == null) return false;
  const expiresAtMs = Date.parse(input.expiresAt);
  if (!Number.isFinite(expiresAtMs)) return false;
  return input.nowMs >= expiresAtMs - input.leewaySeconds * 1000;
}

/** RFC 6901-ish JSON pointer, enough for "/access_token" and "/data/0/token". */
export function jsonPointerGet(value: unknown, pointer: string): unknown {
  if (pointer === "") return value;
  let current = value;
  for (const rawSegment of pointer.replace(/^\//, "").split("/")) {
    const segment = rawSegment.replaceAll("~1", "/").replaceAll("~0", "~");
    if (current == null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}
