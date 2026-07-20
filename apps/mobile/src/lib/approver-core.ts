// Pure P-256 ECDSA "software" approval-key crypto — no Expo imports, so this
// is the exact code the live e2e drives from Node (docs/testing.md:
// dependency-inject the credential, don't mock the transport). approver.ts
// binds this to expo-secure-store for on-device persistence.
//
// This is the SAME "software" key kind packages/iterate/src/approval-keys.ts
// already documents and uses for CI/non-Mac development — same wire protocol
// (uncompressed P-256 point, raw 64-byte r‖s signature, the approval.v1
// canonical message from egress-approvals.ts), just backed by a pure-JS curve
// implementation (@noble/curves) instead of WebCrypto, since Hermes has no
// crypto.subtle. A phone key is therefore genuinely real and server-verified
// exactly like a CI machine's — NOT hardware-isolated like the Secure Enclave
// path, though. See tasks/mobile-native-capabilities.md for that gap.

import { p256 } from "@noble/curves/nist.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { base64ToBytes, bytesToBase64 } from "../../../os/src/domains/projects/egress-approvals.ts";

/**
 * Hermes has no WebCrypto, so @noble/curves' internal randomness source
 * (`crypto.getRandomValues`) is missing on-device. Node (this file's own
 * vitest/e2e runs) already provides it, so the guard is a no-op there.
 * approver.ts calls this once at app startup with expo-crypto's
 * getRandomValues, which has the identical Web Crypto signature.
 */
export function installRandomSource(getRandomValues: (array: Uint8Array) => Uint8Array): void {
  if (typeof globalThis.crypto?.getRandomValues === "function") return;
  Object.defineProperty(globalThis, "crypto", {
    configurable: true,
    value: { ...globalThis.crypto, getRandomValues },
  });
}

export type ApproverKeyMaterial = {
  keyId: string;
  /** Base64 uncompressed P-256 public point (65 bytes, 0x04‖X‖Y) — the wire format egress-approvals.ts expects. */
  publicKey: string;
  /** Base64 raw 32-byte private scalar. Never leaves this process. */
  privateKey: string;
};

export function generateApproverKey(): ApproverKeyMaterial {
  const privateKey = p256.utils.randomSecretKey();
  const publicKey = p256.getPublicKey(privateKey, false);
  const publicKeyBase64 = bytesToBase64(publicKey);
  return {
    keyId: keyIdFor(publicKeyBase64),
    publicKey: publicKeyBase64,
    privateKey: bytesToBase64(privateKey),
  };
}

/** Matches apps/os/.../egress-approvals.ts's approvalKeyId: first 16 hex chars of the public key's SHA-256. */
export function keyIdFor(publicKeyBase64: string): string {
  const hash = sha256(base64ToBytes(publicKeyBase64));
  return [...hash]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 16);
}

/** Base64 raw 64-byte r‖s ECDSA-P256-SHA256 signature over the canonical approval message — what evaluateGrant verifies. */
export function signApprovalMessage(privateKeyBase64: string, message: Uint8Array): string {
  const signature = p256.sign(message, base64ToBytes(privateKeyBase64));
  return bytesToBase64(signature);
}
