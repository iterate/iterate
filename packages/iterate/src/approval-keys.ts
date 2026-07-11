// ─────────────────────────────────────────────────────────────────────────────
// Local approval keys for `iterate approve`.
//
// One key per project, stored under XDG config
// (~/.config/iterate/approval-keys/<projectId>.json). Two kinds:
//
// - "secure-enclave" (macOS): the private key lives in the Secure Enclave and
//   physically cannot leave it; every signature demands a fresh Touch ID /
//   Face ID check (`.biometryCurrentSet`, so re-enrolling biometrics kills
//   the key). The key file holds the public half plus the CryptoKit
//   `dataRepresentation` blob — an encrypted handle only this machine's
//   enclave can use (no keychain: ad-hoc binaries lack the entitlement, same
//   approach as age-plugin-se). Deleting the key file destroys the only
//   handle. The native side is enclave-approver.swift — one file compiled
//   with swiftc on first use (cache keyed by source hash, next to the key
//   files) that owns keygen, signing, and the native approval dialog.
//
// - "software" (everywhere else / --software): a WebCrypto P-256 key whose
//   private JWK sits in the key file. Same protocol, none of the hardware
//   guarantees — fine for CI and non-Mac development.
//
// Signatures are raw 64-byte r‖s over the canonical approval message; the
// enclave emits DER, converted here before anything leaves the machine.
// ─────────────────────────────────────────────────────────────────────────────

import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod/v4";
import {
  approvalKeyId,
  base64ToBytes,
  bytesToBase64,
  derSignatureToRaw,
  type HumanApprovalRequestedPayload,
} from "../../../apps/os/src/domains/projects/egress-approvals.ts";
import { run } from "./run-command.ts";

const APPROVAL_KEYS_DIR = join(
  process.env.XDG_CONFIG_HOME ? process.env.XDG_CONFIG_HOME : join(homedir(), ".config"),
  "iterate",
  "approval-keys",
);

const StoredApprovalKey = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("secure-enclave"),
    keyId: z.string(),
    /** Base64 uncompressed P-256 public point (65 bytes). */
    publicKey: z.string(),
    label: z.string(),
    /** Base64 CryptoKit dataRepresentation — the enclave key's only handle. */
    keyBlob: z.string(),
  }),
  z.object({
    kind: z.literal("software"),
    keyId: z.string(),
    publicKey: z.string(),
    label: z.string(),
    privateKeyJwk: z.record(z.string(), z.unknown()),
  }),
]);

export type StoredApprovalKey = z.output<typeof StoredApprovalKey>;

function keyPath(projectId: string): string {
  return join(APPROVAL_KEYS_DIR, `${projectId}.json`);
}

export async function loadApprovalKey(projectId: string): Promise<StoredApprovalKey | null> {
  let raw: string;
  try {
    raw = await readFile(keyPath(projectId), "utf8");
  } catch {
    return null;
  }
  return StoredApprovalKey.parse(JSON.parse(raw));
}

/**
 * Generate and persist this project's approval key: Secure Enclave when the
 * machine can (macOS + swiftc), software P-256 otherwise or when forced.
 */
export async function createApprovalKey(input: {
  projectId: string;
  label: string;
  software?: boolean;
  log?: (message: string) => void;
}): Promise<StoredApprovalKey> {
  const log = input.log ?? (() => {});
  const useEnclave = input.software !== true && process.platform === "darwin";
  let key: StoredApprovalKey;
  if (useEnclave) {
    log("Generating a Secure Enclave key (Touch ID guards every signature)...");
    const approver = await ensureEnclaveApprover();
    const generated = z
      .object({ publicKey: z.string(), keyBlob: z.string() })
      .parse(await runJson(approver, ["generate"]));
    key = {
      kind: "secure-enclave",
      keyId: await approvalKeyId(generated.publicKey),
      publicKey: generated.publicKey,
      label: input.label,
      keyBlob: generated.keyBlob,
    };
  } else {
    log("Generating a software P-256 key (no Secure Enclave on this machine)...");
    const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
      "sign",
      "verify",
    ]);
    const publicKey = bytesToBase64(
      new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey)),
    );
    key = {
      kind: "software",
      keyId: await approvalKeyId(publicKey),
      publicKey,
      label: input.label,
      privateKeyJwk: (await crypto.subtle.exportKey("jwk", pair.privateKey)) as Record<
        string,
        unknown
      >,
    };
  }
  await mkdir(APPROVAL_KEYS_DIR, { recursive: true });
  await writeFile(keyPath(input.projectId), `${JSON.stringify(key, null, 2)}\n`);
  await chmod(keyPath(input.projectId), 0o600);
  return key;
}

/** Sign the canonical approval message; returns the base64 raw 64-byte r‖s signature. */
export async function signApprovalMessage(
  key: StoredApprovalKey,
  message: Uint8Array,
): Promise<string> {
  if (key.kind === "secure-enclave") {
    const approver = await ensureEnclaveApprover();
    const signed = await runJson(approver, ["sign"], {
      keyBlob: key.keyBlob,
      message: bytesToBase64(message),
    });
    const der = z.object({ signatureDer: z.string() }).parse(signed).signatureDer;
    return bytesToBase64(derSignatureToRaw(base64ToBytes(der)));
  }
  const privateKey = await crypto.subtle.importKey(
    "jwk",
    key.privateKeyJwk as JsonWebKey,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    privateKey,
    message as BufferSource,
  );
  return bytesToBase64(new Uint8Array(signature));
}

/**
 * One native dialog for one held request; approving signs in the same
 * gesture (dialog button → Touch ID sheet), so what the human read is what
 * the signature covers. Secure Enclave keys only — software keys have no
 * native moment worth a dialog.
 */
export async function promptNativeApproval(input: {
  key: Extract<StoredApprovalKey, { kind: "secure-enclave" }>;
  message: Uint8Array;
  /** The human-approval-requested payload, rendered by the dialog. */
  request: HumanApprovalRequestedPayload;
}): Promise<{ decision: "granted"; signature: string } | { decision: "rejected" | "ignored" }> {
  const approver = await ensureEnclaveApprover();
  const answer = z
    .object({
      decision: z.enum(["granted", "rejected", "ignored"]),
      signatureDer: z.string().optional(),
    })
    .parse(
      await runJson(approver, ["approve"], {
        keyBlob: input.key.keyBlob,
        message: bytesToBase64(input.message),
        request: input.request,
      }),
    );
  if (answer.decision !== "granted") return { decision: answer.decision };
  return {
    decision: "granted",
    signature: bytesToBase64(derSignatureToRaw(base64ToBytes(answer.signatureDer!))),
  };
}

/**
 * Destroy the LOCAL key material. The key file holds the enclave key's only
 * handle (or the software key's private JWK), so deleting it is the
 * destruction. The caller appends the `human-approval-key-revoked` event —
 * deletion and revocation are separate acts, and revocation is the one that
 * changes what the platform accepts.
 */
export async function deleteApprovalKey(projectId: string): Promise<void> {
  await rm(keyPath(projectId), { force: true });
}

// ── the native enclave approver ──────────────────────────────────────────────

/**
 * Compile enclave-approver.swift on first use (any Mac with the Xcode
 * command-line tools has swiftc) and cache the binary next to the key files,
 * keyed by source hash — editing the Swift transparently recompiles.
 */
async function ensureEnclaveApprover(): Promise<string> {
  const sourcePath = join(import.meta.dirname, "enclave-approver.swift");
  const source = await readFile(sourcePath, "utf8");
  const binaryPath = join(
    APPROVAL_KEYS_DIR,
    `enclave-approver-${createHash("sha256").update(source).digest("hex").slice(0, 8)}`,
  );
  try {
    await readFile(binaryPath);
    return binaryPath;
  } catch {
    // fall through to compile
  }
  await mkdir(APPROVAL_KEYS_DIR, { recursive: true });
  const compile = await run("swiftc", ["-O", "-o", binaryPath, sourcePath]);
  if (compile.exitCode !== 0) {
    throw new Error(
      `swiftc failed (exit ${compile.exitCode}) — install the Xcode command-line tools ` +
        `(xcode-select --install) or use --software-key.\n${compile.stderr.trim()}`,
    );
  }
  return binaryPath;
}

/**
 * Run an approver command. Anything key-bearing travels as a JSON envelope on
 * STDIN — argv is world-readable via ps, so the key blob never goes there.
 */
async function runJson(command: string, args: string[], stdin?: object): Promise<unknown> {
  const result = await run(command, args, stdin === undefined ? undefined : JSON.stringify(stdin));
  if (result.exitCode !== 0) {
    throw new Error(
      `${command} ${args[0]} failed (exit ${result.exitCode}): ${result.stderr.trim() || "no output"}`,
    );
  }
  return JSON.parse(result.stdout);
}
