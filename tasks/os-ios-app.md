---
status: ready
size: large
---

# os-ios-app

**Status summary (for skimmers):** spec complete (grill-you interview done, see `tasks/os-ios-app.interview.md`); implementation not started. Main pieces: new `apps/mobile` Expo app on main (chat-first), plumbing ported from the voice-ios-app branch, live vitest e2e of the chat round-trip. Missing: everything; on-device pass needs Misha's phone.

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

- [ ] `apps/mobile` scaffold on main: Expo SDK 57, expo-router, tanstack-query, tsconfig/vitest wiring, joins root typecheck/lint/test, excluded from knip; no wrangler/envs.ts entry (not a worker); native build stays out of CI
- [ ] Port `lib/{auth,itx,storage,servers,theme}.ts` from voice-ios-app branch with attribution + divergence comments (`/api` dial, `iterate` scheme, chat presets)
- [ ] Screens: sign-in (in-app browser PKCE), server picker (presets + custom URL + recents), project picker (org name as secondary label), chat list (live `/agents` catalogue, compose affordance), chat thread (bubbles + working indicator + composer), new chat (compose → mint `/agents/mobile/<ts>` → becomes thread), sign-out
- [ ] Live subscription for the chat thread (mirror `useItxSubscription`/`useItxState` semantics from `apps/os/src/itx/itx-react.tsx` — reconnect + liveness watchdog)
- [ ] Vitest e2e spec inside apps/mobile driving the app's own auth/itx modules from Node against the ambient environment (dev-server discovery file or env var; forge-minted bearer token): authenticate → new mobile agent → sendMessage → observe reply event. Doubles as the regression net; pointing at a preview is a doppler-config change
- [ ] Unit tests for pure-TS logic (working-indicator derivation, servers/recents persistence)
- [ ] Verify bundle health: `expo prebuild` + `expo export` clean
- [ ] Docs: `apps/mobile/README.md` — how to run (Expo Go QR), how to point at prod/preview/captun-dev, verification boundary
- [ ] Handoff notes for the one manual on-device pass (Expo Go → sign in → send → see reply), including the captun path live-check

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
