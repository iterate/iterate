// ─────────────────────────────────────────────────────────────────────────────
// Local approval keys for `iterate approve`.
//
// One key per project, stored under XDG config
// (~/.config/iterate/approval-keys/<projectId>.json). Two kinds:
//
// - "secure-enclave" (macOS): the private key lives in the Secure Enclave and
//   physically cannot leave it; every signature demands a fresh Touch ID /
//   Face ID check (`.biometryCurrentSet`, so re-enrolling biometrics kills
//   the key). The key file holds only the public half and the keychain tag.
//   A tiny vendored Swift helper (compiled with swiftc on first use, cached
//   next to the key files) does the two enclave operations.
//
// - "software" (everywhere else / --software): a WebCrypto P-256 key whose
//   private JWK sits in the key file. Same protocol, none of the hardware
//   guarantees — fine for CI and non-Mac development.
//
// Signatures are raw 64-byte r‖s over the canonical approval message; the
// enclave emits DER, converted here before anything leaves the machine.
// ─────────────────────────────────────────────────────────────────────────────

import { spawn } from "node:child_process";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod/v4";
import {
  approvalKeyId,
  base64ToBytes,
  bytesToBase64,
  derSignatureToRaw,
} from "../../../apps/os/src/domains/projects/egress-approvals.ts";

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
    /** Keychain application tag the enclave key is stored under. */
    keychainTag: z.string(),
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
    const helper = await ensureEnclaveHelper();
    const keychainTag = `com.iterate.approve.${input.projectId}`;
    const generated = await runJson(helper, ["generate", keychainTag]);
    const publicKey = z.object({ publicKey: z.string() }).parse(generated).publicKey;
    key = {
      kind: "secure-enclave",
      keyId: await approvalKeyId(publicKey),
      publicKey,
      label: input.label,
      keychainTag,
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
    const helper = await ensureEnclaveHelper();
    const signed = await runJson(helper, ["sign", key.keychainTag, bytesToBase64(message)]);
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

// ── the Secure Enclave helper ────────────────────────────────────────────────

const HELPER_VERSION = 1;

/**
 * Compile the vendored Swift helper on first use (any Mac with the Xcode
 * command-line tools has swiftc) and cache the binary next to the key files.
 */
async function ensureEnclaveHelper(): Promise<string> {
  const helperPath = join(APPROVAL_KEYS_DIR, `enclave-signer-v${HELPER_VERSION}`);
  try {
    await readFile(helperPath);
    return helperPath;
  } catch {
    // fall through to compile
  }
  await mkdir(APPROVAL_KEYS_DIR, { recursive: true });
  const sourcePath = join(tmpdir(), `iterate-enclave-signer-${process.pid}.swift`);
  await writeFile(sourcePath, ENCLAVE_SIGNER_SWIFT);
  try {
    const compile = await run("swiftc", ["-O", "-o", helperPath, sourcePath]);
    if (compile.exitCode !== 0) {
      throw new Error(
        `swiftc failed (exit ${compile.exitCode}) — install the Xcode command-line tools ` +
          `(xcode-select --install) or use --software.\n${compile.stderr.trim()}`,
      );
    }
  } finally {
    await rm(sourcePath, { force: true });
  }
  return helperPath;
}

async function runJson(command: string, args: string[]): Promise<unknown> {
  const result = await run(command, args);
  if (result.exitCode !== 0) {
    throw new Error(
      `${command} ${args[0]} failed (exit ${result.exitCode}): ${result.stderr.trim() || "no output"}`,
    );
  }
  return JSON.parse(result.stdout);
}

function run(command: string, args: string[]) {
  return new Promise<{ stdout: string; stderr: string; exitCode: number }>((resolve, reject) => {
    const child = spawn(command, args);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (data) => (stdout += data));
    child.stderr.on("data", (data) => (stderr += data));
    child.on("error", reject);
    child.on("close", (code) => resolve({ stdout, stderr, exitCode: code ?? 1 }));
  });
}

/**
 * The whole enclave surface: `generate <tag>` mints a biometry-guarded P-256
 * key in the Secure Enclave and prints its public point; `sign <tag>
 * <messageBase64>` signs with `.ecdsaSignatureMessageX962SHA256` (the enclave
 * hashes the message itself) and prints the DER signature. Vendored as a
 * string so the published CLI needs no asset resolution.
 */
const ENCLAVE_SIGNER_SWIFT = `
import Foundation
import Security

func fail(_ message: String) -> Never {
  FileHandle.standardError.write((message + "\\n").data(using: .utf8)!)
  exit(1)
}

func jsonOut(_ dict: [String: String]) {
  let data = try! JSONSerialization.data(withJSONObject: dict)
  print(String(data: data, encoding: .utf8)!)
}

let args = CommandLine.arguments
guard args.count >= 3 else {
  fail("usage: enclave-signer generate <tag> | sign <tag> <messageBase64>")
}
let command = args[1]
let tag = args[2].data(using: .utf8)!

switch command {
case "generate":
  var error: Unmanaged<CFError>?
  guard let accessControl = SecAccessControlCreateWithFlags(
    kCFAllocatorDefault,
    kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
    [.privateKeyUsage, .biometryCurrentSet],
    &error
  ) else { fail("access control: \\(error!.takeRetainedValue())") }

  let attributes: [String: Any] = [
    kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
    kSecAttrKeySizeInBits as String: 256,
    kSecAttrTokenID as String: kSecAttrTokenIDSecureEnclave,
    kSecPrivateKeyAttrs as String: [
      kSecAttrIsPermanent as String: true,
      kSecAttrApplicationTag as String: tag,
      kSecAttrAccessControl as String: accessControl,
    ],
  ]
  guard let privateKey = SecKeyCreateRandomKey(attributes as CFDictionary, &error) else {
    fail("key generation failed: \\(error!.takeRetainedValue())")
  }
  guard let publicKey = SecKeyCopyPublicKey(privateKey),
        let publicKeyData = SecKeyCopyExternalRepresentation(publicKey, &error) as Data? else {
    fail("public key export failed")
  }
  jsonOut(["publicKey": publicKeyData.base64EncodedString()])

case "sign":
  guard args.count >= 4, let message = Data(base64Encoded: args[3]) else {
    fail("sign needs <tag> <messageBase64>")
  }
  let query: [String: Any] = [
    kSecClass as String: kSecClassKey,
    kSecAttrApplicationTag as String: tag,
    kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
    kSecReturnRef as String: true,
    kSecUseOperationPrompt as String: "Sign an iterate egress approval",
  ]
  var item: CFTypeRef?
  let status = SecItemCopyMatching(query as CFDictionary, &item)
  guard status == errSecSuccess else { fail("approval key not found in keychain: \\(status)") }
  let privateKey = item as! SecKey
  var error: Unmanaged<CFError>?
  guard let signature = SecKeyCreateSignature(
    privateKey, .ecdsaSignatureMessageX962SHA256, message as CFData, &error
  ) as Data? else {
    fail("signing failed: \\(error!.takeRetainedValue())")
  }
  jsonOut(["signatureDer": signature.base64EncodedString()])

default:
  fail("unknown command \\(command)")
}
`;
