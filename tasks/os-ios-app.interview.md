# grill-you interview — os-ios-app

Topic: iOS app equivalent of apps/os (v1: start a chat from the phone; auth wired up; prod/preview/dev targeting).

Interviewer: main Claude session, answering on Misha's behalf. Answers marked `[guess: ...]` are judgement calls, not sourced facts.
Interviewee: sub-claude (sonnet) running grill-with-docs in the os-ios-app worktree. Session `1ac4e6d1-eac4-4ff2-ab1a-462b1737549f`.

Pre-decided in the dossier (not interviewed): Expo/React Native over Swift (no local Xcode makes Swift un-iterable by an agent; web app is React; itx types come straight from apps/os/src/types.ts; prior art apps/mobile on the voice-ios-app branch is already Expo; OTA JS delivery fits the platform). Real OAuth code+PKCE, tokens in keychain. Must target prd/preview_N/local dev. No PR until the user says.

---

## Q1 — relationship to PR #1605's apps/mobile — 2026-07-07

The voice-ios-app branch (PR #1605, unmerged, stacked on #1591) already has `apps/mobile` with reusable plumbing (auth/itx/storage/servers/theme) plus voice-specific bits. Options: build fresh on main porting the plumbing; branch off voice-ios-app; or cherry-pick files. Recommended: fresh on main, copying the plumbing files with attribution.

## A1

Option 1 with option-3 mechanics — copy `src/lib/{auth,itx,storage,servers,theme}.ts` nearly verbatim with attribution comments naming the source branch and each deliberate divergence (dial `/api` not `/api/itx`; non-voice scheme; no PR-preview preset). Keep the SAME directory `apps/mobile` and package name `@iterate-com/mobile` deliberately: product-wise there is ONE iterate mobile app — chat is its trunk, voice grafts on when #1605's chain merges; accept the merge cost, the divergence comments make reconciliation mechanical. `[guess: user prefers one mobile app with voice folded in later — inferred from "iOS app equivalent of apps/os, eventually more native features"]` Plain Expo Go for dev (no expo-dev-client — no native modules in v1); general bundle id/scheme (com.iterate.mobile / `iterate`), not voice's.

---

## Q2 — agent path channel + chat list scope

"web" in `/agents/web/<slugified-timestamp>` is a channel discriminator (siblings: slack, mcp, onboarding); no create RPC — first `sendMessage` lazily seeds the agent. Mobile should mint `/agents/mobile/<ts>`. Chat list: mirror web's unfiltered `/agents` catalogue, or scope to mobile-only? Recommended: unfiltered.

## A2

Agreed on both: mint at `/agents/mobile/...`, list unfiltered. Correction to the framing: the channel segment is creation-time provenance only — the phone can open ANY listed agent (web/slack/...) and `sendMessage` to it, so cross-channel continuation falls out naturally and is a v1 requirement (tap any chat, keep talking), not a non-goal.

---

## Q3 — chat screen rendering scope

Web chat renders rich activity (LLM steps, code execution) via the `AgentUiState` reducer in packages/ui. Options: text-only; text-only + derived "working…" indicator; port the reducer. Recommended text-only, indicator as follow-up — while noting long code-execution turns could look broken.

## A3

Option 2 in v1 (the interviewer's own caveat wins): bubbles from `agents/user-message-received` + `agents/web-message-sent` only, plus a derived "working…" state from other in-flight activity on the stream. No reducer port, no step content, no Streamdown. `[guess: assistant messages render as plain text in v1, no markdown renderer — acceptable dogfooding roughness; markdown is a follow-up]` If `agent-ui-reducer.ts` turns out pure-TS and cleanly importable, the implementer MAY use it just for the working flag.

---

## Q4 — phone → local dev

captun (`apps/tunnels`, docs/dev-environments.md): `CAPTUN_TUNNEL_NAME=<name>` on `pnpm dev` publishes local dev at `https://<name>.tunnels.iterate.com`, forwards websockets, auto-registers the URL as an OAuth callback for personal dev_<user> configs. Recommended over LAN-IP/mDNS invention; switcher treats every environment as a plain base URL.

## A4

Agreed on both (LAN IPs would also fail OAuth audience validation). Switcher: one uniform "server" = base URL; presets Production + preview_1..9 (hardcoded from the stable envs.ts naming convention) + free-text custom URL persisting recents (where captun URLs go); default Production. `[guess: prd default — this is "an improvement on going to os.iterate.com"]` Task-file note: implementer must live-verify the captun path once (sign-in + message through the tunnel) — the audience behavior for tunnel origins is documented but unproven from a non-browser client.

---

## Q5 — sharing the itx contract types

Voice branch precedent: type-only relative import `import type {...} from "../../../os/src/types.ts"` — erased at compile time, no runtime coupling, contract breaks surface as typecheck failures. Recommended carrying forward unchanged.

## A5

Agreed, unchanged. Copying types would be silent drift by design — hard no. The immediate-typecheck-break coupling is the feature.

---

## Q6 — no org UI needed; full v1 screen list

Finding: no "active org" concept exists — tokens carry all orgs, `projects.list()` flattens across them, and the `project` OAuth scope forces zero-org users through auth's `/project-access` (org creation) inside the sign-in browser. Proposed screens: sign-in, server picker, project picker (org as secondary label), chat list, chat thread, new chat, sign-out. Recommended remembering last server+project.

## A6

Agreed, including remember-last. Carry the org finding into the task file so nobody reinvents an org switcher. Sharpened boot path: north-star metric is cold-app-open → typing a new message in a couple of taps; with valid stored auth + remembered project, land directly on the chat list with compose one obvious tap away. `[guess: chat-list-with-prominent-compose as the landing rather than an empty composer — the list doubles as "resume recent chat"]`

---

## Q7 — delivery to phone + verification boundary

Plain Expo Go: install from App Store, `expo start`, scan QR — no Apple Developer account/EAS/TestFlight for v1. Agent verifies prebuild/export/tsc/lint/vitest; on-device smoke is the user's manual step.

## A7

Agreed, with the bar raised: before handoff the agent must also run a LIVE node-driven e2e of the ported client modules against a real deployment (bearer authenticate over the capnweb ws → `agents.get('/agents/mobile/<ts>').sendMessage` → observe the reply event), credentialed by minted forge tokens; interactive PKCE stays on-device-only. Installing Xcode is an authorized fallback (blanket install permissions granted) but ~15GB and not plan-of-record.

---

## Q8 — live e2e target environment

Recommended: local dev by default (mint token offline, drive `http://localhost:<port>/api` from Node); preview/prod exercised implicitly.

## A8

Agreed, refined per docs/testing.md: write it as a normal vitest spec inside apps/mobile importing the app's own itx/auth modules, base URL from the ambient environment (dev-server discovery file or env var), credential minted like existing e2e lanes — pointing at a preview is a doppler-config change, not a new script. The spec doubles as the regression net for the ported plumbing.

---

Sub-claude: "Ready for Phase 2."
