---
status: complete
size: medium
---

# Mobile integrations view

## Status

Complete. The drawer route, OS-matched `/agents` → `/integrations` → `/repos`
navigation, full mobile catalogue and connection controls, unit coverage,
phone-sized proof, mobile OTA, and refreshed preview E2E are green.

## Goal

Give each project in the mobile app an Integrations screen equivalent to the
dashboard's `/integrations` view, adapted to a phone-sized native UI.

## Scope

- [x] Add Integrations to the project drawer and route it to a project-scoped screen. *Added the Expo Router screen and typed drawer destination.*
- [x] List Slack, Google/Gmail, GitHub, and Telegram connections with their current connected state and external identity. *`listMobileIntegrations` joins catalogue journals with live status.*
- [x] Let users start Slack, Google, and GitHub browser-based connect flows and return to the mobile app. *The signed callback URL returns through Expo Linking and handles provider errors/GitHub moves.*
- [x] Let users connect Telegram by BotFather token, including the existing explicit move confirmation when the bot belongs to another project. *Token prompts call the existing RPC and retry with `steal: true` only after confirmation.*
- [x] Let users disconnect built-in connections behind an explicit confirmation. *Connected rows use the shared disconnect RPC after a native/web confirm.*
- [x] Show project-provided integrations and the platform API integrations exposed by the dashboard as read-only cards. *Both dashboard sections are rendered below connectable cards.*
- [x] Cover deterministic data shaping in Vitest and the real phone-sized route/navigation/list state in Playwright without requiring third-party credentials. *Vitest proves status joins; Playwright signs up, opens the drawer, and asserts the real empty catalogue.*
- [x] Verify the mobile build/typecheck/tests and the preview deployment, with visual proof in the draft PR. *Mobile typecheck and all 85 unit tests pass; preview 9, its 390×844 screenshot, the mobile OTA, and the same-head broad preview rerun are green.*

## Assumptions

- “Equivalent” means the dashboard's connection management and discovery
  surface, not its adjacent live `/integrations` event stream. Mobile has no
  general stream inspector today.
- Telegram access-list editing and GitHub-installation steal confirmation after
  OAuth are part of parity where the callback supplies those states; the first
  implementation may keep these as clear follow-up errors only if the native
  callback contract cannot safely represent them.
- Browser OAuth uses the server's existing signed `callbackUrl` and an
  `iterate://` Expo Router URL, so the system browser returns to the same screen.
- Tests stop before third-party authorization. A fresh project with no
  connections is enough to prove the screen calls the real integration list,
  renders all connect choices, and is reachable through the drawer.

## Implementation log

- 2026-08-07: Read the dashboard route, mobile app shell, generated integration
  contract, and `fix/mobile-approval-event-delivery`. That PR removes the two
  quarantined mobile Playwright skips and keeps UI assertions backed by durable
  API diagnostics; this task will follow its real signup/project navigation
  pattern while avoiding credential-dependent provider calls.
- 2026-08-07: Implemented OAuth, Telegram, non-OAuth account, disconnect,
  access-policy, provided-mount, and platform-capability UI. Mobile typecheck,
  all 85 mobile unit tests, root lint, formatting, and Playwright discovery pass.
- 2026-08-07: Full repo typecheck and knip pass. The parallel root test run hit
  one unrelated `packages/iterate` CLI loader failure; its exact failing test
  passed immediately in isolation. Expo web export also passes. Local live UI
  proof cannot start because this machine has no Doppler binary/config.
- 2026-08-07: GitHub publishing is waiting on credentials: both HTTPS/SSH and
  `gh` are unauthenticated, and GitHub's device flow reaches a sign-in page with
  no logged-in browser session. The committed branch remains local-only.
- 2026-08-07: Audited the current unskip work in draft PR #2428. Its restored
  specs validate real preview signup and mobile UI while preserving durable
  diagnostics for asynchronous delivery gaps. The audit also caught a parity
  hole here: generic account-session secrets were omitted because only Waitrose
  has a typed integration family. Mobile now joins `secrets.list()` too, renders
  every dashboard-style account connection, and optimistically shows a new
  account while the project secret index folds.
- 2026-08-07: GitHub access was restored and draft PR #2453 was opened with a
  mobile OTA preview. The first Cloudflare deploy exposed a broken legacy
  `preview-8` OS worker before tests; the PR now requests clean slot
  `preview-9` for the verification rerun.
- 2026-08-07: `preview-9` deployed the branch and the real local mobile web
  build signed up, opened the project drawer, loaded the live integration
  catalogue, and produced PR media at a 390×844 viewport. The feature spec was
  not among the failing cases. Broad preview CI is still red on three
  out-of-scope `main` tests whose new projects cannot find the `agent` or
  `workspace` subscription; the same missing `agent-collection` subscription
  appeared on a freshly-created manual proof project before the integrations
  route loaded successfully.
- 2026-08-10: Reproduced the reported home-screen error directly with
  `projects.get("mobile-integrations-pr-2453").agents.list()` against preview 9.
  It is the upstream offset-0 processor snapshot regression fixed by #2456,
  not an integrations change. Merged current `main`; the inherited regression
  spec and processor-relay unit suite pass, as do mobile typecheck and all 85
  mobile unit tests. Refreshed preview proof is pending.
- 2026-08-10: Matched the project drawer's primary navigation to OS:
  `/agents`, `/integrations`, `/repos`. Removed the mobile-only Examples and
  Notifications entries from that primary group; the remaining OS sections are
  explicitly follow-up scope.
- 2026-08-10: The refreshed preview deployed the latest head. The original
  `agents.list()` CLI repro now returns `[]`; broad preview E2E passed on the
  same-head rerun after an unrelated Dummy Petshop OAuth flake. All PR checks
  are green.
