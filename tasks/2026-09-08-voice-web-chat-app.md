---
state: draft
priority: medium
size: large
tags: [voice, packages, apps, web]
dependsOn: [2026-09-08-voice-agent-package.md]
---

# A web voice chat for every project: `VoiceAgentApp.fetch`, hosted and proxied like the Docs app

`@iterate-com/voice-agent` (#2600) makes the voice agent one package.json
line away for any project, and `VoiceAgentApp.create(env)` gives the
project worker the guest's methods. What a project still cannot do is put a
person in front of the agent from a browser: the clients today are the
ESP32 boards, the voicelab host CLI (C, a Mac's audio hardware), and the
mobile app.

The Docs app shows the shape: a hosted web app (`docs.iterate.workers.dev`)
that a config worker mounts on an app subdomain with one line —
`DocsApp.create(this.env, { auth: { policy: "project-member" }, proxy })` —
and the project's own auth in front of it. The voice twin:

- `VoiceAgentApp.create(env, { auth, proxy })` gains `fetch(request)`: the
  member-gated proxy to a hosted voice web app, so `voice--<project>` (or
  `voice.<custom host>`) is a page with a talk button.
- The page is the browser counterpart of the mobile client: microphone in
  (PCM16 mono 16 kHz, push-to-talk first, open mic once AEC is tuned),
  speaker out on the `spk-frame` protocol (`drop`, `pcm`, `last` — the
  three-line buffer policy from apps/os/scripts/voicelab/README.md), the
  itx WebSocket to the stream, and `ensureVoiceAgentSetup`'s marker logic
  from apps/mobile/src/lib/voice-setup.ts lifted into shared code.
- Call any chat from its page, the way the mobile app's phone button does
  (per-chat lines, colleaguePath).

Open questions before starting: whether the hosted app lives in this repo
(apps/voice, deployed like apps/docs) or ships inside the package as a
prebuilt client the way the guestbook does; what the browser needs from the
platform that capnweb over WebSocket does not already give it; and whether
the voicelab e2e can drive the page headlessly with the utterance driver.
