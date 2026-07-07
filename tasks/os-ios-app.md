---
status: implemented, needs on-device pass
size: large
---

# os-ios-app

**Status summary (for skimmers):** implemented and verified up to the machine's limits. Done: `apps/mobile` Expo app (sign-in → projects → chat list → live thread), all plumbing ported/adapted, unit tests, `expo export`/`prebuild` clean, and a LIVE e2e that passed against a real local dev server (bearer auth over the app's own dial → new `/agents/mobile/<ts>` chat → real agent reply → live subscription). Also fixed a pre-existing platform gap: local dev servers now trust forge-minted tokens (`apps/os/scripts/dev.ts`). Missing: the one manual on-device pass (Expo Go on Misha's phone — see "Handoff" below) and the captun live-check.

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

## Found along the way (fixed here)

Local dev servers rejected forge-minted bearer tokens with "missing or invalid auth" — the deploy path bakes the forge public key into the JWKS but `pnpm dev` had no equivalent, which is exactly `tasks/os-dev-server-auth-minting-without-auth-worker.md` (pre-existing, high-priority, small). Fixed in `apps/os/scripts/dev.ts`: at startup, when the Doppler config carries `AUTH_FORGE_PRIVATE_JWK` but no pinned `APP_CONFIG_ITERATE_AUTH__JWKS`, it fetches the issuer's JWKS, merges the forge public key, and injects the result into the vite child env (best-effort, warns and continues on failure — never blocks dev boot). Verified live: both admin-secret and forged-bearer lanes authenticate against a fresh dev server.

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

- Working-indicator upgrade to real activity rows (port or share `AgentUiState`)
- Markdown rendering (Streamdown equivalent for RN)
- Push notifications on agent replies (needs a dev build / EAS — leaves Expo Go)
- Reconcile with PR #1605 when its chain merges (voice screen onto this trunk)

## Implementation log

- 2026-07-07 PM: on-device pass hit "Project is incompatible with this version of Expo Go" — the App Store ships Expo Go 54.0.2 (SDK 54 only, unchanged since 2025-09) while the app inherited SDK 57 from the voice branch (which never used Expo Go — it built a dev client). Downgraded to SDK 54 (`pnpm add expo@sdk-54` + `expo install --fix`; RN 0.81.5, expo-router 6, react 19.1) and documented the pin in the README. All lanes re-verified green after the downgrade: typecheck, 6 unit tests, expo export, Metro manifest now `exposdk:54.0.0`, live e2e round-trip 9s.
