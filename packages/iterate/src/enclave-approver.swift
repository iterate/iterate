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
// Commands (results are one-line JSON on stdout; every command except
// `generate` reads a JSON envelope from STDIN — never argv, which any local
// process can read via ps):
//   generate                     mint a key
//                                -> {"publicKey": b64 X9.63, "keyBlob": b64 handle}
//   sign                         stdin {"keyBlob", "message": b64}; Touch ID, then sign
//                                -> {"signatureDer": base64}
//   approve                      stdin {"keyBlob", "message": b64, "request": {...}};
//                                native dialog for one held egress request;
//                                approving signs in the same gesture
//                                -> {"decision":"granted","signatureDer":...}
//                                 | {"decision":"rejected"} | {"decision":"ignored"}

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
/// check for every signature, presented with `reason`. Throws so callers can
/// tell a cancelled sheet from a structural failure.
func signMessage(blobBase64: String, message: Data, reason: String) throws -> Data {
  let context = LAContext()
  context.localizedReason = reason
  let key = loadKey(blobBase64: blobBase64, context: context)
  return try key.signature(for: message).derRepresentation
}

/// LAError.userCancel and friends surface wrapped by CryptoKit; match on the
/// description rather than unwrapping every layering variant.
func isCancellation(_ error: Error) -> Bool {
  return "\(error)".lowercased().contains("cancel")
}

let args = CommandLine.arguments
guard args.count >= 2 else {
  fail("usage: enclave-approver generate | sign | approve (inputs as JSON on stdin)")
}

/// The stdin envelope for key-holding commands: {"keyBlob", "message"?, "request"?}.
func readStdinEnvelope() -> (keyBlob: String, message: Data?, request: [String: Any]?) {
  let raw = FileHandle.standardInput.readDataToEndOfFile()
  guard let envelope = try? JSONSerialization.jsonObject(with: raw) as? [String: Any],
    let keyBlob = envelope["keyBlob"] as? String
  else { fail("stdin must be a JSON object with at least keyBlob") }
  var message: Data?
  if let messageBase64 = envelope["message"] as? String {
    guard let decoded = Data(base64Encoded: messageBase64) else { fail("message is not base64") }
    message = decoded
  }
  return (keyBlob, message, envelope["request"] as? [String: Any])
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

case "sign":
  let envelope = readStdinEnvelope()
  guard let message = envelope.message else { fail("sign needs message on stdin") }
  do {
    let signature = try signMessage(
      blobBase64: envelope.keyBlob, message: message, reason: "sign an iterate egress approval")
    jsonOut(["signatureDer": signature.base64EncodedString()])
  } catch {
    fail("signing failed: \(error)")
  }

case "approve":
  let envelope = readStdinEnvelope()
  guard let message = envelope.message, let request = envelope.request else {
    fail("approve needs message and request on stdin")
  }

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
    do {
      let signature = try signMessage(
        blobBase64: envelope.keyBlob, message: message,
        reason: "approve \(method) to \(URL(string: url)?.host ?? url)")
      jsonOut(["decision": "granted", "signatureDer": signature.base64EncodedString()])
    } catch {
      // A cancelled Touch ID sheet is the human changing their mind — Ignore.
      // Anything else is structural and must fail loudly, not loop silently.
      if isCancellation(error) {
        jsonOut(["decision": "ignored"])
      } else {
        fail("signing failed: \(error)")
      }
    }
  case .alertSecondButtonReturn:
    jsonOut(["decision": "rejected"])
  default:
    jsonOut(["decision": "ignored"])
  }

default:
  fail("unknown command \(args[1])")
}
