// The phone as a human-approval-key holder: expo-secure-store binding of the
// pure crypto in approver-core.ts (which the live e2e drives from Node with no
// Expo imports at all).
//
// Storage is two Keychain items per project: the public half (keyId,
// publicKey, label) readable without a prompt, so the UI can show enrollment
// status at a glance, and the private key behind `requireAuthentication:
// true` — every signature demands a fresh Face ID / Touch ID / passcode
// check, the same "the human read this and approved it" guarantee the
// Secure Enclave path gives, just without hardware key isolation (the key
// exists in JS memory for the moment of signing). See
// tasks/mobile-native-capabilities.md for closing that gap with a real dev
// build.

import * as Crypto from "expo-crypto";
import * as SecureStore from "expo-secure-store";
import { generateApproverKey, installRandomSource, signApprovalMessage } from "./approver-core.ts";

installRandomSource(Crypto.getRandomValues);

export type ApproverKeyInfo = { keyId: string; publicKey: string; label: string };

function publicKey_(projectId: string) {
  return `iterate.approver.${projectId}.public`;
}
function privateKey_(projectId: string) {
  return `iterate.approver.${projectId}.private`;
}

/** The enrolled key's public info, or null if this device hasn't enrolled for this project. Never prompts. */
export async function loadApproverKey(projectId: string): Promise<ApproverKeyInfo | null> {
  const raw = await SecureStore.getItemAsync(publicKey_(projectId));
  if (!raw) return null;
  return JSON.parse(raw) as ApproverKeyInfo;
}

/**
 * Generate this device's approval key and persist it (idempotent — returns
 * the existing key if already enrolled). Appending `human-approval-key-added`
 * so the project actually trusts it is the caller's job (same split as the
 * CLI's enrollKey/stream.append).
 */
export async function enrollApproverKey(
  projectId: string,
  label: string,
): Promise<ApproverKeyInfo> {
  const existing = await loadApproverKey(projectId);
  if (existing) return existing;
  const key = generateApproverKey();
  await SecureStore.setItemAsync(privateKey_(projectId), key.privateKey, {
    requireAuthentication: true,
    authenticationPrompt: "Enroll this device to approve requests for this project",
  });
  const info: ApproverKeyInfo = { keyId: key.keyId, publicKey: key.publicKey, label };
  await SecureStore.setItemAsync(publicKey_(projectId), JSON.stringify(info));
  return info;
}

/** Sign one approval message — prompts Face ID / Touch ID / passcode to unlock the private key. */
export async function signWithApproverKey(
  projectId: string,
  message: Uint8Array,
): Promise<{ keyId: string; signature: string }> {
  const info = await loadApproverKey(projectId);
  if (!info) throw new Error("This device has no enrolled approval key for this project.");
  const privateKey = await SecureStore.getItemAsync(privateKey_(projectId), {
    requireAuthentication: true,
    authenticationPrompt: "Approve this request",
  });
  if (!privateKey)
    throw new Error("Enrolled key's public half exists but the private half is gone.");
  return { keyId: info.keyId, signature: signApprovalMessage(privateKey, message) };
}

/** Local key material only — the caller still needs to append `human-approval-key-revoked` for the platform to stop trusting it. */
export async function deleteApproverKey(projectId: string): Promise<void> {
  await SecureStore.deleteItemAsync(publicKey_(projectId));
  await SecureStore.deleteItemAsync(privateKey_(projectId));
}
