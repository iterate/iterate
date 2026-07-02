---
status: needs-grilling
size: large
---

# voice-ios-app

Native iOS client (Expo) for the voice ↔ itx bridge from PR #1591
(`mmkal/26/07/02/voice-itx-bridge`, the base branch of this one).

Goal: an app Misha can build to his iPhone with `npx expo run:ios --device`,
sign in to iterate, pick/create a project, create chats, and hold a real
spoken conversation with the project's worker agent — the phone as a thin I/O
pump for the server-side voice stream processor, exactly like the browser
client in `apps/os/src/components/voice/voice-session.ts`.

Spec being fleshed out via grill-you interview; transcript will land alongside
this file as `voice-ios-app.interview.md`.
