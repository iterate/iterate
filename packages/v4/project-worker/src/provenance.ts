// provenance.ts — independently-verifiable event evidence. Provenance says only that these
// Ed25519 keys signed this semantic event at this project/path; authorization remains a separate
// policy concern. The one public preparation function keeps canonicalisation, bounded decoding,
// WebCrypto and the receipt together so the append door cannot accidentally persist assertions.

import { z, ZodError } from "zod";
import { codedError } from "./lib/errors.ts";
import type { SqlStorageHandle } from "./stream/reduce-checkpoint.ts";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

const JSONValue: z.ZodType<Json> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number().finite(),
    z.string(),
    z.array(JSONValue),
    z.record(z.string(), JSONValue),
  ]),
);

const ProvenanceSignature = z.strictObject({
  algorithm: z.literal("Ed25519"),
  publicKey: z.string().min(1).max(86),
  signature: z.string().min(1).max(86),
});

const ProvenanceEvidence = z.strictObject({
  signatures: z.array(ProvenanceSignature).min(1).max(16),
});

const Location = z.strictObject({
  projectId: z.string().min(1),
  path: z.string().startsWith("/"),
});

const SignedEvent = z.strictObject({
  type: z.string(),
  payload: z.record(z.string(), JSONValue).optional(),
  metadata: z.record(z.string(), JSONValue).optional(),
  source: z.record(z.string(), JSONValue).optional(),
  idempotencyKey: z.string().optional(),
});

const AppendInput = z
  .looseObject({
    ephemeral: z.literal(true).optional(),
    provenance: ProvenanceEvidence.optional(),
  })
  .superRefine((input, ctx) => {
    if (Object.hasOwn(input, "verification")) {
      ctx.addIssue({
        code: "custom",
        message: "append: verification is server-derived and cannot be supplied",
      });
    }
  });

export type ProvenanceEvidence = z.infer<typeof ProvenanceEvidence>;
/** The commit-time observation. `signerKeyIds` is the cryptographic result; the remaining fields
 * are deliberately a dated policy decision, never a claim made by the supplied evidence. */
export type ProvenanceVerification = {
  signerKeyIds: string[];
  signers?: { keyId: string; trusted: boolean }[];
  level?: 0 | 1 | 2;
  policyOffset?: number;
};

const TrustedKeyId = z.string().superRefine((keyId, ctx) => {
  if (!keyId.startsWith("ed25519:")) {
    ctx.addIssue({ code: "custom", message: "trusted key must be an Ed25519 key id" });
    return;
  }
  try {
    decodeCanonicalBase64Url(keyId.slice("ed25519:".length), 32, "trusted public key");
  } catch {
    ctx.addIssue({ code: "custom", message: "trusted key is not canonical base64url" });
  }
});

const TrustPolicy = z
  .strictObject({
    keys: z.array(TrustedKeyId).max(64),
    minimumLevel: z.union([z.literal(0), z.literal(1), z.literal(2)]),
    minimumSigners: z.number().int().min(1).max(16).default(1),
  })
  .superRefine((policy, ctx) => {
    if (new Set(policy.keys).size !== policy.keys.length)
      ctx.addIssue({ code: "custom", message: "trusted keys must be distinct" });
    if (policy.minimumLevel === 2 && policy.minimumSigners > policy.keys.length)
      ctx.addIssue({ code: "custom", message: "minimumSigners exceeds configured trusted keys" });
  });

const TrustConfiguration = z.strictObject({
  keys: TrustPolicy.shape.keys,
  minimumLevel: TrustPolicy.shape.minimumLevel,
  minimumSigners: TrustPolicy.shape.minimumSigners.optional(),
});

export type TrustPolicy = z.infer<typeof TrustPolicy>;
export const TRUST_CONFIGURATION = "events.iterate.com/provenance/trust-configured";

type TrustState = { policy: TrustPolicy | undefined; policyOffset: number };
export type TrustDecision = {
  verification: ProvenanceVerification | undefined;
  nextPolicy?: TrustPolicy;
};

/** True only for the one ordinary event that changes the append-time trust policy. */
export function isTrustConfiguration(event: { type: unknown; payload?: unknown }): boolean {
  return event.type === TRUST_CONFIGURATION;
}

function parseTrustConfiguration(payload: unknown): TrustPolicy {
  try {
    return TrustPolicy.parse(TrustConfiguration.parse(payload));
  } catch (error) {
    if (error instanceof ZodError)
      throw codedError(
        "PROVENANCE_INVALID",
        `append: invalid trust configuration: ${error.issues[0]?.message ?? "invalid payload"}`,
      );
    throw error;
  }
}

/**
 * Decides this fact under the policy that existed immediately before it. The caller keeps the
 * returned `nextPolicy` local until the event's own transaction has accepted it, so a batch can
 * rotate keys sequentially without retrospectively re-authorising earlier facts.
 */
export function decideTrust(
  event: { type: string; payload?: unknown; provenance?: unknown; ephemeral?: true },
  cryptoVerification: ProvenanceVerification | undefined,
  state: TrustState,
): TrustDecision {
  if (event.ephemeral && isTrustConfiguration(event))
    throw codedError("PROVENANCE_INVALID", "append: trust configuration must be durable");
  if (event.provenance !== undefined && cryptoVerification === undefined)
    throw codedError("PROVENANCE_INVALID", "append: provenance was not verified before commit");

  const configuration = isTrustConfiguration(event)
    ? parseTrustConfiguration(event.payload)
    : undefined;
  const signerKeyIds = cryptoVerification?.signerKeyIds ?? [];
  // Preserve the original unsigned envelope byte-for-byte until somebody opts this context into
  // trust policy. Signed evidence always receives a receipt, even before that first configuration.
  if (state.policy === undefined && configuration === undefined && signerKeyIds.length === 0)
    return { verification: undefined };

  const policy = state.policy;
  const signers = signerKeyIds.map((keyId) => ({
    keyId,
    trusted: policy?.keys.includes(keyId) ?? false,
  }));
  const level: 0 | 1 | 2 = signers.some((signer) => signer.trusted)
    ? 2
    : signers.length > 0
      ? 1
      : 0;
  const accepted =
    policy?.minimumLevel === 2 ? signers.filter((signer) => signer.trusted).length : signers.length;
  if (
    policy !== undefined &&
    (level < policy.minimumLevel || (policy.minimumLevel > 0 && accepted < policy.minimumSigners))
  )
    throw codedError(
      "PROVENANCE_REQUIRED",
      `append: this context requires ${policy.minimumSigners} signatures at level ${policy.minimumLevel}`,
    );
  if (
    configuration !== undefined &&
    policy !== undefined &&
    !signers.some((signer) => signer.trusted)
  )
    throw codedError(
      "PROVENANCE_REQUIRED",
      "append: trust reconfiguration requires a currently trusted signer",
    );

  return {
    verification: {
      signerKeyIds,
      signers,
      level,
      policyOffset: state.policyOffset,
    },
    ...(configuration === undefined ? {} : { nextPolicy: configuration }),
  };
}

/**
 * The durable half of policy projection. It has no in-memory cache: every fresh event reads the
 * current committed row, applies its receipt using that old row, then writes a configuration at
 * the event's assigned offset. A Stream transaction rolls all of it back with the event.
 */
export class TrustPolicyStore {
  readonly #sql: SqlStorageHandle;

  constructor(sql: SqlStorageHandle) {
    this.#sql = sql;
    sql.exec(
      "CREATE TABLE IF NOT EXISTS provenance_trust_policy (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), policy TEXT NOT NULL, configured_offset INTEGER NOT NULL)",
    );
  }

  /** Apply only a fresh durable event, inside the transaction that will persist it. */
  apply(event: {
    type: string;
    payload?: Record<string, unknown>;
    provenance?: ProvenanceEvidence;
    ephemeral?: true;
    verification?: ProvenanceVerification;
    offset: number;
  }): void {
    const decision = decideTrust(event, event.verification, this.#state());
    if (decision.verification === undefined) delete event.verification;
    else event.verification = decision.verification;
    if (decision.nextPolicy !== undefined)
      this.#sql.exec(
        "INSERT INTO provenance_trust_policy (singleton, policy, configured_offset) VALUES (1, ?, ?) ON CONFLICT(singleton) DO UPDATE SET policy=excluded.policy, configured_offset=excluded.configured_offset",
        JSON.stringify(decision.nextPolicy),
        event.offset,
      );
  }

  #state(): TrustState {
    const row = this.#sql
      .exec<{ policy: string; configured_offset: number }>(
        "SELECT policy, configured_offset FROM provenance_trust_policy WHERE singleton = 1",
      )
      .toArray()[0];
    if (!row) return { policy: undefined, policyOffset: 0 };
    try {
      return {
        policy: TrustPolicy.parse(JSON.parse(row.policy)),
        policyOffset: row.configured_offset,
      };
    } catch {
      throw codedError("PROVENANCE_INVALID", "stored trust policy is invalid");
    }
  }
}

/** Canonical UTF-8 signed text for one event at one context. Derived fields such as offset,
 * creation time, submitted evidence and the server receipt deliberately never enter this body. */
export function provenanceMessage(
  input: Record<string, unknown>,
  location: { projectId: string; path: string },
): string {
  const parsedLocation = Location.parse(location);
  const event = SignedEvent.parse({
    type: input.type,
    ...(input.payload === undefined ? {} : { payload: input.payload }),
    ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
    ...(input.source === undefined ? {} : { source: input.source }),
    ...(input.idempotencyKey === undefined ? {} : { idempotencyKey: input.idempotencyKey }),
  });
  return canonicalJson({
    event,
    path: parsedLocation.path,
    projectId: parsedLocation.projectId,
    v: 1,
  });
}

/** Verify bounded Ed25519 evidence before Stream's synchronous transaction. An undefined result
 * means the legacy unsigned envelope is untouched; every other result is a server-derived receipt. */
export async function prepareProvenance(
  input: Record<string, unknown>,
  location: { projectId: string; path: string },
): Promise<ProvenanceVerification | undefined> {
  try {
    const append = AppendInput.parse(input);
    const evidence = append.provenance;
    if (append.ephemeral && isTrustConfiguration({ type: input.type, payload: input.payload }))
      throw codedError("PROVENANCE_INVALID", "append: trust configuration must be durable");
    if (evidence === undefined) return undefined;
    if (append.ephemeral)
      throw codedError("PROVENANCE_INVALID", "append: signed events must be durable");

    const message = new TextEncoder().encode(provenanceMessage(input, location));
    const signerKeyIds = await Promise.all(
      evidence.signatures.map(async (signature) => {
        const publicKey = decodeCanonicalBase64Url(signature.publicKey, 32, "public key");
        const signatureBytes = decodeCanonicalBase64Url(signature.signature, 64, "signature");
        let key: CryptoKey;
        try {
          key = await crypto.subtle.importKey("raw", publicKey, { name: "Ed25519" }, false, [
            "verify",
          ]);
        } catch (error) {
          if (error instanceof DOMException && error.name === "DataError") {
            throw codedError("PROVENANCE_INVALID", "append: invalid Ed25519 public key");
          }
          throw error;
        }
        let verified: boolean;
        try {
          verified = await crypto.subtle.verify("Ed25519", key, signatureBytes, message);
        } catch (error) {
          if (error instanceof DOMException && error.name === "DataError") {
            throw codedError("PROVENANCE_INVALID", "append: invalid Ed25519 signature");
          }
          throw error;
        }
        if (!verified)
          throw codedError("PROVENANCE_INVALID", "append: Ed25519 signature does not verify");
        return `ed25519:${signature.publicKey}`;
      }),
    );
    const distinct = new Set(signerKeyIds);
    if (distinct.size !== signerKeyIds.length)
      throw codedError("PROVENANCE_INVALID", "append: duplicate provenance signer");
    return { signerKeyIds: [...distinct].sort() };
  } catch (error) {
    if (error instanceof ZodError) {
      throw codedError(
        "PROVENANCE_INVALID",
        `append: invalid provenance: ${error.issues[0]?.message ?? "invalid input"}`,
      );
    }
    throw error;
  }
}

function canonicalJson(value: Json): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key]!)}`)
    .join(",")}}`;
}

function decodeCanonicalBase64Url(
  value: string,
  expectedLength: number,
  label: string,
): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value))
    throw codedError("PROVENANCE_INVALID", `append: ${label} is not canonical base64url`);
  let binary: string;
  try {
    binary = atob(value.replaceAll("-", "+").replaceAll("_", "/"));
  } catch {
    throw codedError("PROVENANCE_INVALID", `append: ${label} is not canonical base64url`);
  }
  const bytes = Uint8Array.from(binary, (character) => character.codePointAt(0)!);
  if (bytes.byteLength !== expectedLength || encodeBase64Url(bytes) !== value) {
    throw codedError("PROVENANCE_INVALID", `append: ${label} is not canonical base64url`);
  }
  return bytes;
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCodePoint(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}
