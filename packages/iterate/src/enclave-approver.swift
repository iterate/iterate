// The native half of `iterate approve` on macOS: a single-file app that owns
// the Secure Enclave key and the human moment. The Node CLI does transport
// (streams over itx) and shells out here for everything the enclave and the
// screen must do. Compiled on first use with swiftc (cache keyed by source
// hash — see approval-keys.ts), so there is nothing to install or notarize.
//
// Keys are CryptoKit `SecureEnclave.P256` keys, NOT keychain items: an
// ad-hoc-signed CLI binary lacks the keychain entitlement (errSecMissing-
// Entitlement -34018), so — like age-plugin-se — the key's opaque
// `dataRepresentation` blob is handed back to the caller to store in its own
// key file. The blob is an encrypted handle: it only works on this machine's
// enclave, the private scalar never leaves the silicon, and the access
// control [.privateKeyUsage, .biometryCurrentSet] makes every signature a
// fresh Touch ID check (re-enrolling biometrics invalidates the key).
// Approving a request is a biometric act — that is the unforgeability story.
//
// Commands (all results are one-line JSON on stdout):
//   generate                                mint a key
//                                           -> {"publicKey": b64 X9.63,
//                                               "keyBlob": b64 handle}
//   public-key <keyBlobBase64>              read back the public point
//                                           -> {"publicKey": b64 X9.63}
//   sign <keyBlobBase64> <messageBase64>    Touch ID, then sign
//                                           -> {"signatureDer": base64}
//   approve <keyBlobBase64> <messageBase64> <requestJsonBase64>
//                                           native dialog for one held egress
//                                           request; approving signs in the
//                                           same gesture
//                                           -> {"decision":"granted","signatureDer":...}
//                                            | {"decision":"rejected"}
//                                            | {"decision":"ignored"}

import AppKit
import CryptoKit
import Foundation
import LocalAuthentication

func fail(_ message: String) -> Never {
  FileHandle.standardError.write((message + "\n").data(using: .utf8)!)
  exit(1)
}

func jsonOut(_ object: [String: Any]) {
  let data = try! JSONSerialization.data(withJSONObject: object)
  print(String(data: data, encoding: .utf8)!)
}

func loadKey(blobBase64: String, context: LAContext? = nil) -> SecureEnclave.P256.Signing.PrivateKey {
  guard let blob = Data(base64Encoded: blobBase64) else { fail("key blob is not base64") }
  do {
    return try SecureEnclave.P256.Signing.PrivateKey(
      dataRepresentation: blob, authenticationContext: context)
  } catch {
    fail("could not load the enclave key from its blob (wrong machine, or biometrics re-enrolled?): \(error)")
  }
}

/// Touch ID happens HERE: the key's access control demands a fresh biometric
/// check for every signature, presented with `reason`.
func signMessage(blobBase64: String, message: Data, reason: String) -> Data {
  let context = LAContext()
  context.localizedReason = reason
  let key = loadKey(blobBase64: blobBase64, context: context)
  do {
    return try key.signature(for: message).derRepresentation
  } catch {
    fail("signing failed: \(error)")
  }
}

let args = CommandLine.arguments
guard args.count >= 2 else {
  fail("usage: enclave-approver generate | public-key <keyBlob> | sign <keyBlob> <messageBase64> | approve <keyBlob> <messageBase64> <requestJsonBase64>")
}

switch args[1] {
case "generate":
  guard SecureEnclave.isAvailable else { fail("this machine has no Secure Enclave") }
  var error: Unmanaged<CFError>?
  guard
    let accessControl = SecAccessControlCreateWithFlags(
      kCFAllocatorDefault,
      kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
      [.privateKeyUsage, .biometryCurrentSet],
      &error
    )
  else { fail("access control: \(error!.takeRetainedValue())") }
  do {
    let key = try SecureEnclave.P256.Signing.PrivateKey(accessControl: accessControl)
    jsonOut([
      "publicKey": key.publicKey.x963Representation.base64EncodedString(),
      "keyBlob": key.dataRepresentation.base64EncodedString(),
    ])
  } catch {
    fail("key generation failed: \(error)")
  }

case "public-key":
  guard args.count >= 3 else { fail("public-key needs <keyBlob>") }
  jsonOut(["publicKey": loadKey(blobBase64: args[2]).publicKey.x963Representation.base64EncodedString()])

case "sign":
  guard args.count >= 4, let message = Data(base64Encoded: args[3]) else {
    fail("sign needs <keyBlob> <messageBase64>")
  }
  let signature = signMessage(
    blobBase64: args[2], message: message, reason: "sign an iterate egress approval")
  jsonOut(["signatureDer": signature.base64EncodedString()])

case "approve":
  guard args.count >= 5,
    let message = Data(base64Encoded: args[3]),
    let requestData = Data(base64Encoded: args[4]),
    let request = try? JSONSerialization.jsonObject(with: requestData) as? [String: Any]
  else { fail("approve needs <keyBlob> <messageBase64> <requestJsonBase64>") }

  // One native dialog per held request. Approving signs in the same gesture:
  // the button click leads straight into the Touch ID sheet, so what the
  // human read is what the signature covers.
  let app = NSApplication.shared
  app.setActivationPolicy(.accessory)

  let method = request["method"] as? String ?? "?"
  let url = request["url"] as? String ?? "?"
  let secretPaths = request["secretPaths"] as? [String] ?? []
  var lines = ["\(method) \(url)"]
  if !secretPaths.isEmpty {
    lines.append("spends secret\(secretPaths.count > 1 ? "s" : ""): \(secretPaths.joined(separator: ", "))")
  }
  if let preview = request["bodyPreview"] as? String {
    lines.append("body: \(preview.count > 200 ? String(preview.prefix(200)) + "…" : preview)")
  }
  if let ruleKey = request["ruleKey"] as? String { lines.append("rule: \(ruleKey)") }
  if let expiresAt = request["expiresAt"] as? String { lines.append("expires: \(expiresAt)") }

  let alert = NSAlert()
  alert.messageText = "Approve this egress request?"
  alert.informativeText = lines.joined(separator: "\n")
  alert.alertStyle = .warning
  alert.addButton(withTitle: "Approve & Sign")
  alert.addButton(withTitle: "Reject")
  alert.addButton(withTitle: "Ignore")

  app.activate(ignoringOtherApps: true)
  let response = alert.runModal()

  switch response {
  case .alertFirstButtonReturn:
    let signature = signMessage(
      blobBase64: args[2], message: message,
      reason: "approve \(method) to \(URL(string: url)?.host ?? url)")
    jsonOut(["decision": "granted", "signatureDer": signature.base64EncodedString()])
  case .alertSecondButtonReturn:
    jsonOut(["decision": "rejected"])
  default:
    jsonOut(["decision": "ignored"])
  }

default:
  fail("unknown command \(args[1])")
}
