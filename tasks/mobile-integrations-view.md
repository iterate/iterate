---
status: in-progress
size: medium
---

# Mobile integrations view

## Status

About 10% complete. The web surface and mobile navigation/test precedents have
been mapped. The mobile screen, connect/disconnect flows, focused tests, preview
proof, and reviewable PR are still missing.

## Goal

Give each project in the mobile app an Integrations screen equivalent to the
dashboard's `/integrations` view, adapted to a phone-sized native UI.

## Scope

- [ ] Add Integrations to the project drawer and route it to a project-scoped screen.
- [ ] List Slack, Google/Gmail, GitHub, and Telegram connections with their current connected state and external identity.
- [ ] Let users start Slack, Google, and GitHub browser-based connect flows and return to the mobile app.
- [ ] Let users connect Telegram by BotFather token, including the existing explicit move confirmation when the bot belongs to another project.
- [ ] Let users disconnect built-in connections behind an explicit confirmation.
- [ ] Show project-provided integrations and the platform API integrations exposed by the dashboard as read-only cards.
- [ ] Cover deterministic data shaping in Vitest and the real phone-sized route/navigation/list state in Playwright without requiring third-party credentials.
- [ ] Verify the mobile build/typecheck/tests and the preview deployment, with visual proof in the draft PR.

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
