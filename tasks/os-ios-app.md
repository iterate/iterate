---
status: needs-grilling
size: large
---

# os-ios-app

iOS app equivalent of apps/os. The v1 goal: a better-than-mobile-web way to start a new chat from a phone — open app, be authenticated, tap new chat, talk. Auth must be wired up properly, and the app must be able to target production, preview deployments, and local dev stacks.

Open question to resolve during grilling: Swift/native vs Expo/React Native. User leans Expo given the web app is React and the platform has a dynamic-JS-script concept, but cedes judgement.

Constraint: this machine has no Xcode (CommandLineTools only) — verification strategy must not depend on local simulator builds.

No PR until the user says so.

_This is a stub; the grill-you interview will flesh it out._
