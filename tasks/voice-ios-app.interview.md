# Interview log: voice-ios-app

Grill-you transcript. A sub-claude ran `grill-with-docs` against the dossier
(iOS voice-agent app on top of PR #1591); the main agent answered on Misha's
behalf. Guesses are tagged `[guess: …]`.

---

## Q1 — what does "create chats" actually mean?

Sub-claude: the web voice page has no chat list — every load generates
`/agents/voice/<timestamp>`. Recommend resolving "login, create chats" down to
login → project picker → voice, no chat list/resume at all; text chat with
non-voice agents out of scope.

## A1

In between: a per-project sessions list, but cheap. Use `project.agents.list()`
filtered to paths under `/agents/voice/` to show past voice sessions (they're
just agent streams), newest first, with a big "New session" action that
generates the timestamp path exactly like the web page. Tapping an old one
reopens the voice screen pointed at that agentPath — the worker agent resumes
with its journal intact even though the realtime voice model starts fresh;
that's acceptable and worth having since it's nearly free. [guess: "create
chats" in the ask reads as "I want to practically get to a working chat", not
"build the dashboard chat UI" — the voice session's built-in text lane covers
typing]. No general-purpose dashboard chat screens for non-voice agents in v1;
the voice screen's text-input lane (and text-only session start, same as the
web "Text only" button) is the typing story.

---

## Q2 — which backend does the app point at, and how is it switchable?

Sub-claude: PR #1591 isn't in prod, so prod would 404 on voice. Recommend a
plain editable server URL persisted to secure storage, no baked default.

## A2

Editable server URL, persisted, but with a real default: this PR gets its own
preview deployment (the repo's PR preview system assigns a slot, e.g.
`https://os.iterate-preview-N.com` — PR #1591 currently holds preview-5), and
that preview will include the voice bridge since this branch is stacked on it.
Default the server field to this branch's preview URL once CI assigns it, and
offer quick-pick chips for prod (`os.iterate.com`), the preview, and
`http://localhost:<port>` for simulator-vs-local-dev. [guess: preview-as-
default — Misha will try the app while both PRs are unmerged, so prod would
just 404 on voice streams]. The auth issuer must not be hand-typed: derive it
from the OS base — try RFC 9728 `/.well-known/oauth-protected-resource` on the
OS host (the MCP surface already advertises resource metadata), fall back to
the os.→auth. hostname convention. Audiences are fine:
`apps/auth/src/server/oauth-resources.ts` lists prod, localhost and all nine
preview hosts as valid OS resource bases.

---

## Q3 — should apps/mobile join root typecheck/lint/test?

Sub-claude: workspace glob picks it up automatically; root lint is lenient
global oxlint; knip is opt-in per workspace. Recommend full participation plus
a real vitest suite for the ported session state machine.

## A3

Full participation: own `tsc --noEmit` typecheck script, rides the global
oxlint, and ships a vitest suite for the ported voice-session state machine
(fake realtime data-channel feeding recorded event JSON, asserting transcript
entries and what gets appended to the agent stream). If some Expo/RN typegen
artifact makes root typecheck flaky, fix it properly (generated files
gitignored + a codegen step in the script) rather than opting out; only exclude
from knip's explicit workspace list. The native build (xcodebuild) stays OUT of
root scripts and CI — verified manually via simulator during implementation.

---

## Q4 — voice screen visual design

Sub-claude pitch: full-screen presence orb as hero (idle/listening/speaking/
thinking states), transcript collapsed behind a swipe-up sheet, bottom bar
(mute / text lane / end), one-line worker status caption under the orb; add
derived `assistantSpeaking`/`workerBusy` snapshot fields to the ported client.

## A4

Yes — all of it. Extras that make it feel native rather than a webview:
keep-awake during a live session, light haptics on session start/end and on
worker-report arrival, respect the brand voice (`docs/brand-and-tone-of-voice.md`,
`docs/design-system.md` — dark-leaning, calm, no cutesy copy), and make
barge-in legible (orb snaps from speaking to listening the moment VAD fires —
with WebRTC the interruption itself is handled server-side, the UI just
reflects it). [guess: transcript-as-sheet over transcript-first — he asked for
"a good voice agent app", and every good one buries the log]. Constraint:
don't sink unbounded time into orb shader art — a well-tuned reanimated
pulse/scale/glow is plenty; usable beats beautiful tonight.

---

## Q5 — token storage and refresh strategy

Sub-claude: 30-min access tokens, refresh via offline_access; bearer is
validated at connect time only. Recommend expo-secure-store, proactive refresh
with ~60s buffer before any new authenticated action, clear-and-relogin on
refresh failure, sign-out = clear keychain.

## A5

Agreed on all of it. Add one cheap belt-and-braces piece: wrap the itx
connect + authenticate step so an auth-shaped failure triggers exactly one
forced refresh + reconnect before surfacing an error — that's a clean seam
because it's connection setup, not a mid-flight RPC. Don't build 401-driven
retry anywhere else. Also: better-auth rotates refresh tokens on every refresh
and treats reuse as theft, so persist the new refresh token atomically before
using the new access token, and single-flight the refresh with an in-memory
promise.

---

## Q6 — app backgrounding during a live session

Sub-claude: recommend foreground-only; backgrounding hard-ends the session; no
UIBackgroundModes entitlement.

## A6

Split the difference. Add `UIBackgroundModes: [audio]` to the Expo config —
one plist line, and it's what makes "start a session, lock the phone, keep
talking" work, which is half the point of a phone voice agent [guess: he'll
try exactly that within five minutes]. But ZERO deliberate background
engineering beyond that line: no interruption choreography, no
reconnect-on-foreground state machine. If iOS kills the audio while
backgrounded, the session shows as ended on return, with a status entry.
If the one-liner misbehaves with react-native-webrtc, drop to foreground-only
and note it in the task file.

---

## Q7 — verification plan without a physical device

Sub-claude: simulator can prove login, lists, sessions, and (on Apple Silicon)
real WebRTC audio via host-mic passthrough; can't prove real-device audio
routing, lock-screen behavior, haptics, keychain-across-kills. Recommend
simulator + vitest as the bar, honest split-checklist in task file and PR.

## A7

That's the right bar, with two additions. (1) The server-side piece — the
realtime-secret mint moving onto the itx surface — must get its own test in
the existing OS suites (apps/os/e2e itx patterns; authenticate and call the
mint capability, asserting shape without necessarily hitting OpenAI), and CI
on this PR must be green. (2) The simulator end-to-end pass should be a real
round-trip against a live deployment: preview if this PR's slot is up, else a
local dev server (doppler dev config has OPENAI_API_KEY — PR #1591's web page
already works there). Screen-record the simulator run and put it in the PR
body per the pull-request-media convention.

---

## Q8 — mic permission denied; socket drops mid-session

Sub-claude: mic denial → start text-only with error entry + Settings deep
link; any socket drop → ended state, no auto-reconnect; asked whether the itx
socket specifically should auto-reconnect.

## A8

Agree on mic denial and on the realtime leg (fail-dead; tap Start re-opens the
SAME agentPath by default, so it feels like resuming). One asymmetry, matching
the web client: the itx lane already retries — the browser's worker-listen
loop re-dials every second while the session lives. Keep that: the itx socket
auto-redials (with the single forced-refresh-on-auth-failure rule) as long as
the realtime leg is live; only the realtime leg is fail-dead. If the itx lane
is down long enough that a user turn can't be forwarded, put an error entry in
the transcript and keep talking — the worker just misses that turn (same as
web behavior when append fails).

---

Sub-claude declared every branch covered and said "Ready for Phase 2".
