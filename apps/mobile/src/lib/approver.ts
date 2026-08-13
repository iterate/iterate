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
import { Platform } from "react-native";
import type { HumanApprovalKey } from "../../../os/src/domains/projects/egress-approvals.ts";
import { EVENT } from "./approvals.ts";
import { getProjectItx } from "./itx.ts";
import * as SecureStore from "./secure-store.ts";
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

/**
 * Auto-enrollment on project open: make sure this device holds an approval
 * key for the project AND the project trusts it — silently (a Keychain WRITE
 * never prompts Face ID; only authenticated reads do). Best-effort by
 * contract: callers fire it from a query on the project home screen, a
 * failure must not block opening the project, and the next open retries.
 * Respect for revocation is the one wrinkle: a key the project has revoked
 * (locally present or not) is NEVER silently re-added — un-revoking is a
 * deliberate human act, so those fall back to the approvals screen's manual
 * enroll after deleting local material.
 */
export async function ensureApproverKeyEnrolled(
  baseUrl: string,
  projectId: string,
): Promise<ApproverKeyInfo | null> {
  const key = await enrollApproverKey(
    projectId,
    Platform.OS === "web" ? "This browser (dev)" : "This iPhone",
  );
  const enrolled = await projectApprovalKeys(baseUrl, projectId);
  const existing = enrolled.find((candidate) => candidate.keyId === key.keyId);
  if (existing) return !existing.revokedAt ? key : null;
  const project = await getProjectItx(baseUrl, projectId);
  await project.streams.get("/").append({
    type: EVENT.keyAdded,
    payload: { keyId: key.keyId, publicKey: key.publicKey, label: key.label },
  });
  return key;
}

export type ApproverKeyStatus =
  | { kind: "unenrolled" }
  | { kind: "enrolled"; key: ApproverKeyInfo }
  | { kind: "revoked"; key: ApproverKeyInfo };

/**
 * What the approvals screen should believe about this device's key — the
 * JOIN of the local Keychain half and the project's enrolled-key state. A
 * locally present key the project has REVOKED must surface as `revoked`,
 * never `enrolled`: the door ignores its signatures, so offering Approve
 * would strand batches as "submitted" until expiry. A local key the project
 * doesn't know yet counts as `enrolled` — auto-enroll's append is in flight.
 */
export async function approverKeyStatus(
  baseUrl: string,
  projectId: string,
): Promise<ApproverKeyStatus> {
  const key = await loadApproverKey(projectId);
  if (!key) return { kind: "unenrolled" };
  const enrolled = await projectApprovalKeys(baseUrl, projectId);
  const entry = enrolled.find((candidate) => candidate.keyId === key.keyId);
  if (entry && entry.revokedAt) return { kind: "revoked", key };
  return { kind: "enrolled", key };
}

/**
 * The deliberate human act that recovers a revoked device: destroy the local
 * material and enroll a FRESH keypair (a new keyId — re-appending a revoked
 * one is a reducer no-op, and silently resurrecting it would defeat
 * revocation). Only the approvals screen's revoked banner calls this.
 */
export async function reenrollApproverKey(
  baseUrl: string,
  projectId: string,
  label: string,
): Promise<ApproverKeyInfo> {
  await deleteApproverKey(projectId);
  const key = await enrollApproverKey(projectId, label);
  const project = await getProjectItx(baseUrl, projectId);
  await project.streams.get("/").append({
    type: EVENT.keyAdded,
    payload: { keyId: key.keyId, publicKey: key.publicKey, label: key.label },
  });
  return key;
}

/**
 * Sign one approval message — prompts Face ID / Touch ID / passcode to
 * unlock the private key. One decision covers a whole batch (the approval.v2
 * message binds every request plus the verdicts), so approving 12 requests
 * is still exactly one prompt and one signature.
 */
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

/**
 * The project's enrolled approval keys, from the project processor's reduced
 * state. The snapshot crosses the itx RPC boundary untyped; the cast is to
 * the CONTRACT-derived {@link HumanApprovalKey} — the exact type the server
 * reduces this field with (project-processor-contract.ts stateSchema), so
 * shape drift is a compile error on the server side, not a runtime surprise
 * here.
 */
async function projectApprovalKeys(
  baseUrl: string,
  projectId: string,
): Promise<HumanApprovalKey[]> {
  const project = await getProjectItx(baseUrl, projectId);
  return (await project.processor.snapshot()).state.humanApprovalKeys as HumanApprovalKey[];
}

/** Local key material only — the caller still needs to append `human-approval-key-revoked` for the platform to stop trusting it. */
export async function deleteApproverKey(projectId: string): Promise<void> {
  await SecureStore.deleteItemAsync(publicKey_(projectId));
  await SecureStore.deleteItemAsync(privateKey_(projectId));
}
