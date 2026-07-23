// =============================================================================
// Human-in-the-loop egress approvals.
//
// The whole idea: egress rules are project state; a held request is an open
// fetch promise plus a `human-approval-requested` event; that event's OFFSET
// is the held request's identity; humans answer by appending events; and
// once approval keys are enrolled, a grant is unforgeable without the
// enrolled private key. The lifecycle:
//
//   requested ──(signed grant)──▶ granted ──▶ released ──▶ settled
//        │
//        ├──(human)────▶ rejected (reason: human)
//        └──(timeout)──▶ rejected (reason: expired)
//
// This file is the pure half — rule matching and the signature scheme — used
// by the gate in project-durable-object.ts (orchestration) and the
// `iterate approve` CLI (the human's signer).
//
// The signature covers canonical JSON bytes reconstructable by BOTH sides
// from the requested event alone (no detached digest): WebCrypto's ECDSA and
// the Secure Enclave's `ecdsaSignatureMessageX962SHA256` both hash the
// message internally, so signer and verifier only ever exchange the raw
// 64-byte r‖s signature.
// =============================================================================

// The event payload and state schemas live INLINE in the project processor
// contract (the contract owns every nested data structure); this module only
// re-exports their inferred types for its own function signatures and for
// the out-of-app importers (the `iterate approve` CLI, the mobile approver).
import type {
  EgressRule,
  HumanApprovalKey,
  HumanApprovalRequestedPayload,
} from "./project-processor-contract.ts";

export type {
  EgressRule,
  HumanApprovalKey,
  HumanApprovalRequestedPayload,
} from "./project-processor-contract.ts";

// -----------------------------------------------------------------------------
// Rule matching.
// -----------------------------------------------------------------------------

/**
 * First-match-wins over the ordered rule list; undefined means "allow".
 * Matching is conjunctive within a rule: every present matcher must accept.
 */
export function matchEgressRule(
  rules: readonly EgressRule[],
  request: { method: string; url: string; secretPaths: readonly string[] },
): EgressRule | undefined {
  // An unparseable URL doesn't throw out of the gate and doesn't waive
  // policy: it only disables the host/path matchers (which need a URL). A rule
  // matching on method or secretPaths still applies — so a bad-URL request
  // that spends a held secret is still caught.
  const url = ((): URL | null => {
    try {
      return new URL(request.url);
    } catch {
      return null;
    }
  })();
  const method = request.method.toUpperCase();
  return rules.find((rule) => {
    const match = rule.match;
    if (match.hosts !== undefined) {
      if (url === null || !match.hosts.some((host) => hostMatches(url.hostname, host)))
        return false;
    }
    if (match.pathPrefix !== undefined) {
      if (url === null || !url.pathname.startsWith(match.pathPrefix)) return false;
    }
    if (
      match.methods !== undefined &&
      !match.methods.some((candidate) => candidate.toUpperCase() === method)
    ) {
      return false;
    }
    if (
      match.secretPaths !== undefined &&
      !match.secretPaths.some((path) => request.secretPaths.includes(path))
    ) {
      return false;
    }
    return true;
  });
}

/** "api.stripe.com" matches exactly; "*.stripe.com" matches any single-or-deeper subdomain. */
function hostMatches(hostname: string, pattern: string): boolean {
  const host = hostname.toLowerCase();
  const candidate = pattern.toLowerCase();
  if (candidate.startsWith("*."))
    return host.endsWith(candidate.slice(1)) && host !== candidate.slice(2);
  return host === candidate;
}

// -----------------------------------------------------------------------------
// Canonical approval message (approval.v1).
// -----------------------------------------------------------------------------

/**
 * JSON with recursively sorted object keys — the canonical form both signer
 * and verifier serialize independently. Deterministic forever: a signature's
 * meaning must stay recomputable from the requested event long after the fact.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value));
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, entry]) => [key, sortKeysDeep(entry)]),
    );
  }
  return value;
}

/**
 * The exact bytes an approval signature covers. Reconstructable by both
 * sides from the requested event alone: the CLI builds it from the event it
 * received, the Project DO from the payload it appended. Display/provenance
 * fields and `expiresAt` are deliberately excluded — the signature covers the
 * body via its hash, and expiry is enforced server-side.
 */
export function buildApprovalMessage(input: {
  projectId: string;
  approvalRequestEventOffset: number;
  requested: Pick<
    HumanApprovalRequestedPayload,
    "method" | "url" | "headers" | "body" | "secretPaths"
  >;
  decision: "granted" | "rejected";
}): Uint8Array {
  return new TextEncoder().encode(
    canonicalJson({
      v: "approval.v1",
      projectId: input.projectId,
      approvalRequestEventOffset: input.approvalRequestEventOffset,
      method: input.requested.method,
      url: input.requested.url,
      headers: input.requested.headers,
      bodySha256: input.requested.body?.sha256,
      secretPaths: input.requested.secretPaths,
      decision: input.decision,
    }),
  );
}

export const APPROVAL_BODY_INSPECTION_LIMIT_BYTES = 64 * 1024;

/** Keep a bounded body prefix for human inspection; UTF-8 stays readable and other bytes are base64. */
export function approvalRequestBody(
  bytes: Uint8Array,
  sha256: string,
): {
  encoding: "utf8" | "base64";
  content: string;
  originalByteLength: number;
  sha256: string;
  truncated: boolean;
} {
  const truncated = bytes.byteLength > APPROVAL_BODY_INSPECTION_LIMIT_BYTES;
  const inspectionBytes = bytes.slice(0, APPROVAL_BODY_INSPECTION_LIMIT_BYTES);
  const metadata = { originalByteLength: bytes.byteLength, sha256, truncated };
  try {
    return {
      encoding: "utf8",
      content: decodeUtf8InspectionBytes(inspectionBytes, truncated),
      ...metadata,
    };
  } catch {
    return { encoding: "base64", content: bytesToBase64(inspectionBytes), ...metadata };
  }
}

function decodeUtf8InspectionBytes(bytes: Uint8Array, truncated: boolean): string {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  if (!truncated) return decoder.decode(bytes);

  // A byte cap may split the final UTF-8 code point. Trim only that incomplete
  // suffix; invalid bytes elsewhere still fall back to the binary/base64 view.
  for (let trim = 0; trim <= 3; trim++) {
    try {
      return decoder.decode(bytes.subarray(0, bytes.byteLength - trim));
    } catch {
      // Try the next possible UTF-8 suffix length.
    }
  }
  throw new Error("The approval body inspection prefix is not UTF-8.");
}

// -----------------------------------------------------------------------------
// Signature verification (WebCrypto, P-256, raw 64-byte r‖s signatures).
// -----------------------------------------------------------------------------

/**
 * THE grant-acceptance policy, in one place: with no active keys enrolled a
 * plain grant is accepted (phase 1); once any active key exists, a grant is
 * accepted only with a valid signature from one of them. Everything else is
 * ignored — never rejected — so a bad grant can't kill a hold that a good
 * one (or a human rejection) would settle.
 */
export async function evaluateGrant(input: {
  grant: { keyId?: string; signature?: string };
  keys: readonly HumanApprovalKey[];
  message: Uint8Array;
}): Promise<{ accepted: true } | { accepted: false; reason: string }> {
  const activeKeys = input.keys.filter((key) => key.revokedAt === null);
  if (activeKeys.length === 0) return { accepted: true };
  const key = activeKeys.find((candidate) => candidate.keyId === input.grant.keyId);
  if (key === undefined) return { accepted: false, reason: "unknown or missing keyId" };
  if (input.grant.signature === undefined) return { accepted: false, reason: "missing signature" };
  const verified = await verifyApprovalSignature({
    publicKey: key.publicKey,
    signature: input.grant.signature,
    message: input.message,
  });
  return verified ? { accepted: true } : { accepted: false, reason: "invalid signature" };
}

/** Verify a raw r‖s ECDSA-P256-SHA256 signature over the canonical message bytes. */
export async function verifyApprovalSignature(input: {
  /** Base64 uncompressed P-256 public point (65 bytes). */
  publicKey: string;
  /** Base64 raw 64-byte r‖s signature. */
  signature: string;
  message: Uint8Array;
}): Promise<boolean> {
  let publicKeyBytes: Uint8Array;
  let signatureBytes: Uint8Array;
  try {
    publicKeyBytes = base64ToBytes(input.publicKey);
    signatureBytes = base64ToBytes(input.signature);
  } catch {
    return false;
  }
  if (publicKeyBytes.length !== 65 || publicKeyBytes[0] !== 0x04) return false;
  if (signatureBytes.length !== 64) return false;
  let key: CryptoKey;
  try {
    key = await crypto.subtle.importKey(
      "raw",
      publicKeyBytes as BufferSource,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
  } catch {
    return false;
  }
  return crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    signatureBytes as BufferSource,
    input.message as BufferSource,
  );
}

/** A key's id is a fingerprint of its public point: first 16 hex chars of its SHA-256. */
export async function approvalKeyId(publicKeyBase64: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    base64ToBytes(publicKeyBase64) as BufferSource,
  );
  return bytesToHex(new Uint8Array(digest)).slice(0, 16);
}

/**
 * DER/ASN.1 ECDSA signature → raw 64-byte r‖s. The Secure Enclave (and most
 * non-WebCrypto signers) emit DER; the platform only ever stores raw.
 */
export function derSignatureToRaw(der: Uint8Array): Uint8Array {
  const read = (offset: number): { bytes: Uint8Array; next: number } => {
    if (der[offset] !== 0x02) throw new Error("invalid DER signature: expected INTEGER");
    const length = der[offset + 1]!;
    const start = offset + 2;
    let bytes = der.slice(start, start + length);
    // Strip the sign-padding zero byte; left-pad back to 32.
    while (bytes.length > 32 && bytes[0] === 0x00) bytes = bytes.slice(1);
    if (bytes.length > 32) throw new Error("invalid DER signature: integer too long");
    const padded = new Uint8Array(32);
    padded.set(bytes, 32 - bytes.length);
    return { bytes: padded, next: start + length };
  };
  if (der[0] !== 0x30) throw new Error("invalid DER signature: expected SEQUENCE");
  // Sequence length may be long-form (0x81) for signatures crossing 127 bytes.
  const headerLength = der[1] === 0x81 ? 3 : 2;
  const r = read(headerLength);
  const s = read(r.next);
  const raw = new Uint8Array(64);
  raw.set(r.bytes, 0);
  raw.set(s.bytes, 32);
  return raw;
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return bytesToHex(new Uint8Array(digest));
}

export function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
