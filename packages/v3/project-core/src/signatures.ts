import { z } from "zod";
import { Fault } from "./model.ts";
import { base64Url } from "./encoding.ts";

/** JSON accepted in signed event data. */
export const Json = z.json();
export type Json = z.infer<typeof Json>;

const PublicKeySchema = z
  .object({
    crv: z.literal("Ed25519"),
    d: z.never().optional(),
    kty: z.literal("OKP"),
    x: z.string().min(1).max(128),
  })
  .passthrough();

const Signature = z.object({
  key: PublicKeySchema,
  value: z
    .string()
    .regex(/^[A-Za-z0-9_-]+$/)
    .max(256),
});

/** The append body. `id` is caller supplied so retries sign the same fact. */
export const EventInput = z
  .strictObject({
    data: Json,
    id: z.string().min(1).max(256),
    provenance: z
      .strictObject({
        parents: z.array(z.string().min(1).max(256)).max(64),
        producer: z.string().min(1).max(160).optional(),
        signatures: z.array(Signature).max(16),
      })
      .optional(),
    type: z.string().min(1).max(256),
  })
  .superRefine((event, ctx) => {
    if (new TextEncoder().encode(canonicalJson(event.data)).byteLength > 65_536) {
      ctx.addIssue({ code: "custom", message: "event data exceeds 65536 UTF-8 bytes" });
    }
  });
export type EventInput = z.infer<typeof EventInput>;

/** A committed event includes the platform-observed location and verification result. */
export const EventRecord = EventInput.extend({
  context: z.string(),
  offset: z.number().int().positive(),
  time: z.number().finite(),
  verification: z.strictObject({
    signers: z.array(z.strictObject({ keyId: z.string(), trusted: z.boolean() })),
    level: z.union([z.literal(0), z.literal(1), z.literal(2)]),
    policyOffset: z.number().int().nonnegative(),
  }),
});
export type EventRecord = z.infer<typeof EventRecord>;

function canonicalJson(value: Json): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("JSON numbers must be finite");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key]!)}`)
    .join(",")}}`;
}

/** Deterministic JSON used for every signed byte sequence in this module. */
export function canonical(value: unknown): string {
  return canonicalJson(Json.parse(value));
}

function signingBytes(context: string, event: EventInput): Uint8Array {
  if (!context || context.length > 256) throw new Error("context must be 1 to 256 characters");
  return new TextEncoder().encode(
    canonical({
      context,
      data: event.data,
      domain: "iterate.event.v1",
      id: event.id,
      type: event.type,
      provenance: {
        parents: event.provenance?.parents ?? [],
        ...(event.provenance?.producer && { producer: event.provenance.producer }),
      },
    }),
  );
}

function decodeBase64Url(value: string): Uint8Array {
  const binary = atob(value.replaceAll("-", "+").replaceAll("_", "/"));
  return Uint8Array.from(binary, (char) => char.codePointAt(0)!);
}

/** A stable public-key identifier; private JWK material is always rejected. */
export async function keyId(key: JsonWebKey): Promise<string> {
  const parsed = PublicKeySchema.parse(key);
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonical({ crv: parsed.crv, kty: parsed.kty, x: parsed.x })),
  );
  return `ed25519:${base64Url(new Uint8Array(digest))}`;
}

/** Verify signatures before the transaction, returning only distinct verified signer identities. */
export async function verifyEvent(context: string, event: EventInput): Promise<readonly string[]> {
  const parsed = EventInput.parse(event);
  const signers = await Promise.all(
    (parsed.provenance?.signatures ?? []).map(async (attestation) => {
      let key: CryptoKey;
      try {
        key = await crypto.subtle.importKey(
          "jwk",
          // Node and workerd disagree on optional JWK `alg` labels for Ed25519.
          // The signed key identity consists only of these standard public fields.
          { kty: attestation.key.kty, crv: attestation.key.crv, x: attestation.key.x },
          { name: "Ed25519" },
          false,
          ["verify"],
        );
      } catch (error) {
        if (error instanceof DOMException)
          throw new Fault("SIGNATURE_INVALID", "Invalid Ed25519 public key", 403);
        throw error;
      }
      // Copy into ArrayBuffer-backed arrays: WebCrypto rejects the broader SharedArrayBuffer type.
      const signature = Uint8Array.from(decodeBase64Url(attestation.value)).buffer;
      const message = Uint8Array.from(signingBytes(context, parsed)).buffer;
      const valid = await crypto.subtle.verify({ name: "Ed25519" }, key, signature, message);
      if (!valid) throw new Fault("SIGNATURE_INVALID", "Event signature is invalid", 403);
      return keyId(attestation.key);
    }),
  );
  if (new Set(signers).size !== signers.length)
    throw new Fault("SIGNATURE_DUPLICATE", "Duplicate event signer", 400);
  return signers;
}
