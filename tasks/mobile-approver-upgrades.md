---
status: backlog, blocked on Apple Developer enrollment + leaving Expo Go
size: medium
---

# mobile-approver-upgrades

**Status summary:** not started. `apps/mobile`'s approvals screen (this branch/PR) ships a real but software-only human-approval-key approver: a `@noble/curves` P-256 keypair, Face-ID-gated at rest via `expo-secure-store`, signing the exact same `approval.v1` protocol `packages/iterate/src/approval-keys.ts`'s CI/non-Mac "software" key kind already uses. This task is the upgrade path from there to something closer to Jonas's Secure Enclave + Touch ID menu-bar approver (PR #1868) — all three items below share one blocker: they need a **dev build**, which needs Xcode (or EAS's cloud builds) and, for distributing it to a phone that isn't attached to a build machine, an **Apple Developer Program membership** ($99/yr) for code signing + TestFlight. None of that is set up yet on this machine (see `~/.claude` memory: "No Xcode on this Mac").

## Why this exists

From the `os-ios-app` interview (see `tasks/os-ios-app.md`): the mobile approver's software key is a genuine, server-verified signature — not a fake — but it's a real security step down from Jonas's Mac: the private key exists in JS memory for the moment of signing rather than staying inside a Secure Enclave that never releases it. That gap, plus push notifications and wider distribution, are the things worth closing once there's a reason to invest in a real dev build.

## Checklist

- [ ] **Hardware-backed signing.** iOS' equivalent of the Secure Enclave path is `SecKeyCreateRandomKey` with `kSecAttrTokenIDSecureEnclave` + `kSecAccessControlBiometryCurrentSet` (Face ID), the same primitive `enclave-approver.swift` uses on macOS via CryptoKit. Expo Go can't touch it — this needs either a small native module (Swift, wrapped as an Expo config plugin) or an existing RN library that exposes Secure Enclave key generation/signing (survey `react-native-keychain`'s Secure Enclave support and `expo-secure-store`'s own biometric-gated storage — as of this writing `expo-secure-store` protects a stored _value_ with biometrics but doesn't do Secure-Enclave-backed _signing_, which is the actual gap). Either way: a dev build, not Expo Go.
- [ ] **Push notifications on new held requests.** `expo-notifications`' remote push path needs a dev build (Expo Go dropped remote push support in SDK 53+/54). Two halves: (1) client — register for a push token, persist it, handle a tapped notification by deep-linking into `/project/[projectId]/approvals`; (2) server — `apps/os` needs to actually send a push when `human-approval-requested` lands (a new small piece: an Expo push token registry keyed by project + device, and a hook off the egress door that calls Expo's push API). Neither half exists yet.
- [ ] **Distribution beyond this Mac's Expo Go.** A dev build is a custom native binary, so it needs code signing. Two paths, both requiring an Apple Developer Program membership: (a) ad-hoc distribution to specific registered device UDIDs (cheapest to iterate on, capped device list), (b) TestFlight via App Store Connect (real distribution, works for anyone with the link, more setup). **EAS Build sidesteps the "no Xcode on this Mac" problem** — it builds in Expo's cloud, so local Xcode is only needed for `expo run:ios`/simulator work, not for producing the binary itself. The Developer Program membership is unavoidable either way.

## Out of scope here

- Re-litigating whether the software key is "good enough" for now — it is, per the `os-ios-app` interview; this task is the explicit upgrade path, not a blocker on shipping the software version.
- Android — no Android approver work implied by any of the above.

## Guesses and assumptions

- Assumed EAS Build (not a locally-built dev client) is the path once this is picked up, since it avoids installing Xcode — flag this if a future agent decides local Xcode is actually preferable (e.g. for faster iteration once installed anyway).
- Assumed the push-token registry is new OS-side state, not reuse of anything existing — no existing "device token" concept was found in `apps/os` at the time this was written.
