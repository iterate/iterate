---
status: implemented, needs on-device pass
size: large
---

# os-ios-app

**Status summary (for skimmers):** implemented and verified up to the machine's limits. Done: `apps/mobile` Expo app (sign-in → projects → chat list → live thread), all plumbing ported/adapted, unit tests, `expo export`/`prebuild` clean, and a LIVE e2e that passed against a real local dev server (bearer auth over the app's own dial → new `/agents/mobile/<ts>` chat → real agent reply → live subscription). A pre-existing platform gap this branch first hit (local dev servers rejecting forge-minted tokens) is now fixed on main independently (PR #1706) — see "Found along the way" below. Missing: the one manual on-device pass (Expo Go on Misha's phone — see "Handoff" below) and the captun live-check.

An iOS app equivalent of apps/os. v1 goal: beat "open Safari → os.iterate.com → log in → new chat" — cold app open to typing a new message in a couple of taps, against any deployment (prd, preview*N, local dev via captun). Foundations over screen count: this is \_the* iterate mobile app; native features (voice, push, widgets) graft on later.

## Decisions (from the grill-you interview — full trail in `tasks/os-ios-app.interview.md`)

- **Expo/React Native, not Swift.** No Xcode on the dev machine makes Swift un-iterable by an agent; the web app is React; itx contract types import straight from `apps/os/src/types.ts`; the prior-art app is already Expo; OTA JS updates fit the platform ethos. v1 uses **plain Expo Go** — no custom native modules, no expo-dev-client, no Apple Developer account, no EAS.
- **Same package as the voice branch, fresh base.** Build `apps/mobile` (`@iterate-com/mobile`) on main; copy `src/lib/{auth,itx,storage,servers,theme}.ts` from the `voice-ios-app` branch (PR #1605) nearly verbatim, with attribution comments naming the source and each deliberate divergence (dial **`/api`**, not that branch's `/api/itx`; scheme `iterate`, bundle id `com.iterate.mobile`, not voice's). One mobile app, singular: chat is the trunk; voice becomes a screen when #1605's chain merges — the divergence comments make that reconciliation mechanical.
- **Chat = agents over itx.** One capnweb websocket to `<base>/api`, `authenticate({type:"bearer",token})`. New chat mints `/agents/mobile/<slugified-timestamp>` — the first `sendMessage` lazily creates the agent (no create RPC; mirrors the web's `/agents/web/...`). Chat list = the unfiltered `/agents` catalogue, same as the web sidebar; tapping ANY agent (web/slack/mobile) opens it and you can keep talking — channel prefix is creation-time provenance only.
- **Rendering scope:** bubbles from `agents/user-message-received` + `agents/web-message-sent` only, plus a derived "working…" indicator from other in-flight stream activity (agent turns run code for tens of seconds; a silent screen reads as broken). No `AgentUiState` reducer port, no step content, plain text (markdown rendering is a follow-up).
- **Auth:** OAuth code + PKCE with RFC 7591 dynamic client registration against apps/auth, issuer discovered from the OS base via RFC 9728 (`/api/mcp/.well-known/oauth-protected-resource`), scopes `openid profile email offline_access project`, refresh tokens in expo-secure-store with rotation-safe single-flight refresh — all already implemented on the voice branch and live-verified against auth.iterate-dev.com. The `project` scope funnels zero-org users through auth's `/project-access` inside the sign-in browser — **no org UI in the app, ever-in-v1**; tokens carry all orgs and `projects.list()` flattens across them.
- **Environments:** one uniform "server" concept = base URL. Presets: Production (`https://os.iterate.com`, default) + preview_1..9 (hardcoded from the stable envs.ts naming convention), plus a custom-URL field persisting recents. Local dev from the phone = captun: `CAPTUN_TUNNEL_NAME=<name> pnpm dev` → `https://<name>.tunnels.iterate.com` as a custom server (websockets forwarded; personal dev configs register the OAuth callback).
- **Types:** type-only relative import from `apps/os/src/types.ts` (voice-branch pattern). Never copy types; a contract change breaking mobile's typecheck is the feature.
- **Boot path:** with valid stored auth + remembered server/project, land on the chat list with compose one tap away. Remember last server + project.

## Checklist

- [x] `apps/mobile` scaffold on main: Expo SDK 57, expo-router, tanstack-query, tsconfig/vitest wiring, joins root typecheck/lint/test, excluded from knip; no wrangler/envs.ts entry (not a worker); native build stays out of CI — _copied non-voice files from the voice-ios-app worktree; knip already ignores `apps/*` except allowlisted apps, no config change needed; added an `apps/mobile → project os` scope to doppler.yaml for the e2e lane_
- [x] Port `lib/{auth,itx,storage,servers,theme}.ts` from voice-ios-app branch with attribution + divergence comments (`/api` dial, `iterate` scheme, chat presets) — _also split the dial into an Expo-free `lib/itx-core.ts` (token getter injected) so the e2e drives the exact phone seam from Node_
- [x] Screens: sign-in (in-app browser PKCE), server picker (presets + custom URL + recents), project picker (org name as secondary label), chat list (live `/agents` catalogue, compose affordance), chat thread (bubbles + working indicator + composer), new chat (compose → mint `/agents/mobile/<ts>` → becomes thread), sign-out — _new chat is the thread screen pointed at a fresh path (reading lazily initializes; first send creates), so there's no separate composer screen_
- [x] Live subscription for the chat thread — _`lib/live-thread.ts`: module-level subscription per thread pushing into the tanstack-query cache (no useEffect anywhere), ping watchdog every 15s, drop-and-refetch recovery; simpler than the web's useItxSubscription by design, noted for convergence later_
- [x] Vitest e2e spec driving the app's own modules from Node — _`e2e/chat-roundtrip.e2e.test.ts`; **passed live** against this worktree's dev server: throwaway project (admin lane) → forge bearer over `dialItx` → sendMessage → real agent reply in ~9s → live subscription saw both messages. Base URL from APP_CONFIG_BASE_URL or the dev-server discovery file_
- [x] Unit tests for pure-TS logic — _6 specs over the chat reducer/merge/path conventions (`src/lib/chat.test.ts`); recents/last-project persistence is thin SecureStore JSON, exercised via the screens_
- [x] Verify bundle health — _`expo export --platform ios` (4MB Hermes bundle) and `expo prebuild` (scheme `iterate` + bundle id land in Info.plist) both clean_
- [x] Docs: `apps/mobile/README.md` — _run via Expo Go QR, deployment targeting incl. captun, verification lane table_
- [x] Handoff notes for the manual on-device pass — _see "Handoff" below_
- [x] ~~Register redirect URIs on the auth worker for the mobile client~~ — _not needed: registration is dynamic (RFC 7591, open by design); the app registers whatever redirect URI its runtime resolves (exp:// in Expo Go, iterate:// standalone)_
- [x] Human-in-the-loop egress approvals from the phone — _new project screen (`/project/[projectId]/approvals`): enroll a real P-256 "software" approval key (same kind `packages/iterate/src/approval-keys.ts` uses for CI/non-Mac dev — `@noble/curves`, since Hermes has no WebCrypto), Face-ID-gated at rest via `expo-secure-store`'s `requireAuthentication`, sign the exact `approval.v1` protocol `apps/os/.../egress-approvals.ts` verifies. Protocol logic ported from `packages/iterate/src/approve-core.ts` (`lib/approvals.ts`) with signing dependency-injected instead of importing the CLI's Node-only key store. Unit tests prove interop with the OS's real `verifyApprovalSignature`/`evaluateGrant`; a live e2e (`e2e/approval-roundtrip.e2e.test.ts`) drives a real held egress fetch through a real hold rule to a real release, signed with this exact code. Upgrade path (hardware-backed signing, push notifications, wider distribution) written up in `tasks/mobile-approver-upgrades.md` — all three need a dev build, which this branch deliberately stays out of (Expo Go only, per the interview's v1 decision)._

## Found along the way

Local dev servers used to reject forge-minted bearer tokens with "missing or invalid auth" — the deploy path bakes the forge public key into the JWKS but `pnpm dev` had no equivalent. PR #1706 fixed this in `generate-wrangler-config.ts` by deriving a forge-only JWKS at config-generation time, with tests and durable documentation. The mobile branch's local `apps/os/scripts/dev.ts` version was dropped as redundant when that fix reached main; the live e2e still exercises the forged-bearer lane against main's implementation.

## Handoff — the one manual pass (needs Misha's phone)

**Progress (2026-07-07 PM):** steps 1–2 done on-device — Expo Go boots the app (after the SDK 54 + metro-runtime pins) and the full OAuth flow completes against production (the missing `maybeCompleteAuthSession()` was the last blocker, caught via Metro-streamed `[auth]` logs). Remaining: step 3 (new chat → agent reply on the phone) and step 4 (captun).

1. `pnpm --dir apps/mobile start` in this worktree, install **Expo Go** from the App Store, scan the QR (same wifi).
2. Sign in against **Production** (default preset) — in-app browser, Google/OTP. This is the first live test of the dynamic-registration + PKCE flow from Expo Go's `exp://` redirect URI (verified for custom schemes on the voice branch; the exp:// variant is the untested delta).
3. Pick a project → New chat → send something → watch for "working…" then the reply.
4. Captun check (the flagged guess): `CAPTUN_TUNNEL_NAME=<name> pnpm dev`, add `https://<name>.tunnels.iterate.com` as a custom server, sign in and send a message through it.

## Out of scope (v1)

- Android (fine if it incidentally works; zero effort)
- Voice (PR #1605's job), push notifications, widgets, offline
- App Store / TestFlight / EAS / Apple Developer account
- Markdown rendering, activity/step detail in chat (follow-ups)
- Re-designing the OS web app or the auth worker

## Guesses and assumptions (flagged during the interview)

- One mobile app with voice folded in later, rather than a separately-named chat app — inferred from "iOS app equivalent of apps/os … eventually more native features".
- Plain-text assistant bubbles acceptable for v1 dogfooding; markdown is a follow-up.
- Production as the default server preset ("an improvement on going to os.iterate.com").
- Landing screen = chat list with prominent compose (doubles as "resume recent chat"), not an empty composer.
- captun OAuth audience behavior for tunnel origins is documented but unproven from a non-browser client — must be live-verified once.

## For the next pass (explicitly deferred)

- ~~Working-indicator upgrade to real activity rows (port or share `AgentUiState`)~~ — _done (user request, same day): the thread screen now folds the shared `@iterate-com/ui` agent-ui-reducer in memory (TUI agent-feed-model pattern) — streaming thinking/code text, tap-to-expand activity cards, and a raw-events view toggle_
- Markdown rendering (Streamdown equivalent for RN) — assistant bubbles and settled responseText are still plain text
- Feed search + event-type filters and the raw-event inspector (web has `q`/`types`/offset bounds + presets: agent-chat / agent-events / everything)
- Interrupt affordance (web appends `agent/llm-request-cancelled` for the running request; queued-messages banner has "interrupt and send now")
- Push notifications on agent replies (needs a dev build / EAS — leaves Expo Go)
- Reconcile with PR #1605 when its chain merges (voice screen onto this trunk)

## Implementation log

- 2026-07-07 PM: on-device pass hit "Project is incompatible with this version of Expo Go" — the App Store ships Expo Go 54.0.2 (SDK 54 only, unchanged since 2025-09) while the app inherited SDK 57 from the voice branch (which never used Expo Go — it built a dev client). Downgraded to SDK 54 (`pnpm add expo@sdk-54` + `expo install --fix`; RN 0.81.5, expo-router 6, react 19.1) and documented the pin in the README. All lanes re-verified green after the downgrade: typecheck, 6 unit tests, expo export, Metro manifest now `exposdk:54.0.0`, live e2e round-trip 9s.
- 2026-07-16: added the human-in-the-loop egress approvals screen (see checklist above) after a conversation about Jonas's Secure Enclave menu-bar approver (PR #1868) and its `itx.approvals.require()`-wrapping-any-promise backlog idea (`tasks/approvals-beyond-http-egress.md`, not yet built — only egress is gated today). Landed the smallest real (non-fake) version reachable from Expo Go: a software P-256 key, Face-ID-gated storage, full live e2e proof. Added `@noble/curves`/`@noble/hashes` as direct `apps/mobile` deps (Metro couldn't resolve `@noble/hashes` as a bare transitive dep of `@noble/curves` under pnpm's isolation — needed its own entry). Extracted `e2e/e2e-helpers.ts` from `chat-roundtrip.e2e.test.ts` once a second e2e file needed the same base-URL/env helpers.
- 2026-07-16: merged 298 commits of main in. One real textual conflict (`pnpm-lock.yaml`, resolved by regenerating). Everything else was semantic drift the merge didn't flag on its own:
  - Dropped this branch's `apps/os/scripts/dev.ts` forge-JWKS fix entirely — main independently closed the same pre-existing task (PR #1706, `generate-wrangler-config.ts`) more completely (tests + docs). `dev.ts` is now byte-identical to main.
  - `apps/os/src/types.ts` is gone (PR #1745, itx types generated from `rpc-targets.ts` into standalone `apps/os/src/itx-api.generated.ts`) — updated every relative type-only import. This is the "immediate-typecheck-break coupling is the feature" decision paying off exactly as intended.
  - `AgentCollection.get(path)`/`ProjectCollection.get(id)` pipelining no longer infers cleanly under the bumped capnweb type patch — adopted the same `as RpcStub<Agent>` cast `apps/os/src/itx-client.ts` uses for its own pipelined handles.
  - `Agent.sendMessage()` was renamed to the unified `Agent.message()` (also accepts `{message, files}`, though `addFiles` is still separate and unchanged).
  - `agent-ui-reducer`'s `planAgentUiOps(state, events[])` batch API became `reduceAgentUi(state, event)` single-event folding (matches `browser-feed/projector.ts`'s new usage) — rewrote `reduceFeed` to fold event-by-event. Its `AgentUiItem` union also grew two new kinds (`child-stream-created`, `stream-paused`/`resumed`); gave them the same thin divider-row treatment the web renderer uses.
  - `StreamEvent` gained a required `path` field — updated test fixtures.
  - There is no `agents/user-message-received` event anymore; user messages are `agents/context-added` events with `payload.role === "user"` (the unified single inbound door). Updated `chat.ts`'s lightweight reducer and test fixtures.
  - Re-verified clean after the fixups: `apps/mobile` typecheck/lint/unit-tests, and the live e2e round-trip against a freshly restarted local dev server on the merged code.
