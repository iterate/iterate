---
state: draft
priority: high
size: epic
tags:
  - cleanup
  - refactor
  - dead-code
  - docs
---

# Thermonuclear Cleanup Plan - Non-OS-Quarantine Scope

Date: 2026-07-02

This report is intentionally aggressive, but it excludes the cleanup already
owned by `/Users/jonastemplestein/.claude/plans/nifty-juggling-candy.md`.
That plan covers the main OS itx cutover work, the OS quarantines, the
`apps/minimal-itx-v4` deletion, and the big shared `callable` / `streams` /
`durable-object-utils` removal.

## Scope Guard

Do not burn cleanup review time here in this report:

| Area                                                                               | Why excluded                                                                     |
| ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `apps/os/test-quarantine/**` and `apps/os/legacy-quarantine/**`                    | Already covered by the active OS cutover/quarantine plan.                        |
| `apps/os/src/next/**` naming, OS `/api/itx` migration docs, OS final topology docs | Already in the active plan. The code is live; the name is migration residue.     |
| `apps/minimal-itx-v4/**`                                                           | Already in the active plan. Current tree appears to have source removed already. |
| `packages/shared/src/callable/**`                                                  | Already in the active plan and apparently removed in the current tree.           |
| `packages/shared/src/streams/**`                                                   | Already in the active plan and apparently removed in the current tree.           |
| `packages/shared/src/durable-object-utils/**`                                      | Already in the active plan and apparently removed in the current tree.           |
| OS Slack/Google legacy implementation                                              | Already quarantined/plan-owned. Keep only behavior notes needed for the rebuild. |

This report focuses on everything else: `packages/ui`, the remaining
`packages/shared` surface, `packages/iterate`, `packages/mock-http-proxy`,
non-OS app packages, root tooling, docs, tasks, and generated/test support.

## Evidence Used

Read-only checks and audits used:

- Specialist subagent passes over shared code, UI code, docs, OS/refactor
  leftovers, and test/quarantine surfaces.
- `pnpm knip` at repo root: clean for the configured workspaces
  (`apps/os`, `apps/semaphore`, `apps/streams-example-app`,
  `packages/shared`).
- `pnpm exec knip --directory ...` for omitted packages:
  `packages/ui`, `packages/iterate`, `packages/mock-http-proxy`,
  `apps/iterate-com`, `apps/auth-example`, `apps/tunnels`,
  `.github/ts-workflows`, and `scripts`.
- Typechecks:
  - `pnpm --dir packages/ui typecheck`: passed.
  - `pnpm --dir packages/shared typecheck`: passed.
  - `pnpm --dir packages/shared test`: passed, 113 tests.
  - `pnpm --dir packages/iterate typecheck`: passed.
  - `pnpm --dir packages/mock-http-proxy typecheck`: passed.
  - `pnpm --dir apps/iterate-com typecheck`: passed.
- Workflow generator dry-run:
  - `node .github/ts-workflows/cli.ts from-ts --dry-run`: clean.

Important caveat: directory-local Knip for `apps/auth`, `apps/semaphore`, and
`apps/streams-example-app` tries to load Vite/Alchemy local config and fails if
`.alchemy/local/wrangler.jsonc` does not exist. Root Knip avoids this for
semaphore/streams by using explicit workspace config. Add the same pattern for
auth rather than relying on directory-local defaults.

## Rating Legend

- Effort:
  - S: same-day focused cleanup.
  - M: one to two days with tests and dependency updates.
  - L: several days; likely touches consumers.
  - XL: architectural move, sequencing required.
- Certainty:
  - 95-100: delete or change is strongly supported by import graph and local checks.
  - 85-94: very likely right; needs normal review.
  - 70-84: plausible, but prove behavior/ownership before deleting.
  - Under 70: investigate, do not start with deletion.

## Executive Kill List

If we want maximum cleanup per unit of risk, do this in order:

1. Add Knip/audit coverage for omitted workspaces, especially `packages/ui`,
   `packages/iterate`, `apps/auth`, `apps/iterate-com`, and
   `packages/mock-http-proxy`.
2. Shrink `packages/ui`: remove unused shadcn inventory, the terminal stack,
   the unused stream composer/prompt-input stack, stale event docs, and broad
   wildcard exports.
3. Shrink remaining `packages/shared`, but keep its strategic platform
   contracts: auth/auth-claims, app config parsing, Alchemy app wiring, and
   event-log/EV-log style infrastructure. Delete only zero-consumer helpers
   like `project-ingress`, `type-tree`, `slug-maker`, `typeid`,
   `nitro-ws-response`, and unused test helpers.
4. Delete non-OS quarantine/reference code: `packages/iterate/test-quarantine`
   and `apps/streams-example-app/test-quarantine` after converting the few
   useful notes into tasks.
5. Keep `packages/mock-http-proxy` for now as potential test infrastructure.
   The cleanup task is to give it ownership and active coverage, not to delete
   it during this pass.
6. Clean the marketing app: delete unused local UI leftovers and fix the broken
   changelog symlink.
7. Archive stale research/task markdown that points to deleted prototypes.
8. Fix package/config defects that make tools lie: inactive patches, invalid
   package exports, root dependency leakage, and stale Knip config.

## Keep List

These looked suspicious but should not be deleted based on current evidence:

| Area                                                                                  | Reason                                                                                                                                                                                                                                                                                                               |
| ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@iterate-com/shared` package                                                         | Still has active shared Interfaces: `config`, `auth-claims`, `oauth-resource`, `slug`, `signup-allowlist`, `evlog`, and `alchemy/*`. Shrink it, do not delete it. Treat auth/config/event-log/app-wiring surfaces as strategic, especially because `apps/auth` is expected to move structurally closer to `apps/os`. |
| Shared auth/config parsing                                                            | Keep anything that expresses auth contracts, auth claims, OAuth resource metadata, signup allowlist behavior, and app config parsing used by OS/auth. These are platform contracts, not utility leftovers.                                                                                                           |
| Shared event log / EV-log direction                                                   | Keep `evlog` code unless a replacement design exists. It may be rebuilt or superseded later, but this cleanup pass should not remove the event-log affordance merely because the current surface is imperfect.                                                                                                       |
| `packages/mock-http-proxy`                                                            | Keep for now. It overlaps with OS egress-test goals but provides generic Node/MSW/MITM/HAR/WebSocket replay capability that OS-local interceptors do not replace.                                                                                                                                                    |
| `apps/auth` and `apps/auth-contract`                                                  | Active auth worker and contract. Auth-contract directory Knip is clean and it has real OS/auth consumers.                                                                                                                                                                                                            |
| `apps/semaphore`                                                                      | Active lease service, root Knip configured for it and clean.                                                                                                                                                                                                                                                         |
| `apps/tunnels`                                                                        | `src/worker.ts` is referenced by Alchemy as a worker entrypoint; directory-local Knip calls it unused only because it does not understand that Alchemy entrypoint.                                                                                                                                                   |
| `apps/auth-example`                                                                   | Documented/deployed OAuth integration reference. It imports `@iterate-com/auth/client` and `@iterate-com/auth/server`; Knip's unused dependency report is likely package export resolution drift.                                                                                                                    |
| `packages/shared/src/alchemy/preupload-worker-assets.ts` and `prune-server-bundle.ts` | Referenced by `packages/shared/src/alchemy/iterate-app.ts` through file URLs. Keep unless `iterate-app` stops spawning them.                                                                                                                                                                                         |
| `.github/ts-workflows/**`                                                             | Directory-local Knip reports TS workflow files unused, but `cli.ts` imports them dynamically. Generator dry-run is clean.                                                                                                                                                                                            |

## Proposal Matrix

### 1. Add Real Dead-Code Coverage For Omitted Workspaces

| Field        | Rating                                                                                                                     |
| ------------ | -------------------------------------------------------------------------------------------------------------------------- |
| Files        | `knip.ts`, `package.json`, workspace package configs                                                                       |
| Effort       | M                                                                                                                          |
| Implications | CI starts reporting unused files/deps in packages that currently rot silently. Expect a first wave of intentional ignores. |
| Certainty    | 98                                                                                                                         |

Comment:

Root `pnpm knip` currently audits only:

- `apps/os`
- `apps/semaphore`
- `apps/streams-example-app`
- `packages/shared`

That leaves `packages/ui`, `packages/iterate`, `apps/auth`, `apps/auth-example`,
`apps/tunnels`, `apps/iterate-com`, `packages/mock-http-proxy`, `scripts`, and
`.github/ts-workflows` outside normal dead-code checks.

Directory-local Knip immediately found real issues:

- `packages/ui`: unused `src/styles.css`, `src/components/button-variants.ts`,
  unused `@iterate-com/shared` and `date-fns`, plus unused exported stream
  processor types.
- `packages/iterate`: unused `pubme.js`, quarantine files, unused deps
  `better-auth` and `yaml`, unused dev deps that mostly exist for quarantined
  code, and unlisted `cloudflare` / `tsgo`.
- `packages/mock-http-proxy`: unused HAR streaming writer, unused integration
  scripts, unused deps/dev deps, and unused exports. Because the package is now
  explicitly being kept, treat these as activation/ownership findings first and
  deletion findings second.
- `apps/iterate-com`: unused local UI components and deps.

Concrete cleanup:

- Add `packages/ui` workspace config with explicit entries and a small ignore
  list.
- Add `packages/iterate` workspace config and either ignore or delete
  `test-quarantine`.
- Add `apps/auth` workspace config with `vite: false` and explicit worker,
  route, script, and config entries, mirroring OS/semaphore patterns.
- Add `apps/iterate-com` and `packages/mock-http-proxy` configs.
- Keep `.github/ts-workflows` out of generic Knip unless its dynamic imports
  are modeled explicitly.

This is the leverage move: it turns future cleanup from archaeology into CI.

### 2. Turn `packages/ui` From A Kitchen Sink Into A Design-System Package

| Field        | Rating                                                                                                                                                                         |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Files        | `packages/ui/package.json`, `packages/ui/src/components/**`, `packages/ui/src/components/ai-elements/**`, `packages/ui/src/components/events/**`, `packages/ui/src/styles/**`  |
| Effort       | L                                                                                                                                                                              |
| Implications | Reduces dependency surface and stops app/domain UI from hiding in a generic UI package. May break private imports if external consumers rely on undocumented wildcard exports. |
| Certainty    | 92                                                                                                                                                                             |

Comment:

`packages/ui` is the richest non-plan cleanup target. It exports broad wildcard
surfaces:

- `./components/*`
- `./components/ai-elements/*`
- `./components/events/feed-element-renderers/*`
- several event internals

This makes everything look public and makes deletion harder than it should be.
The package is not in root Knip, and it carries a heavy dependency set for
components with no current live consumers.

Concrete cleanup:

1. Replace wildcard exports with explicit exports for the actually used
   primitives/components.
2. Add Knip coverage before deleting, then delete or stop exporting unused
   modules.
3. Remove dead package dependencies after each deletion wave.

High-confidence delete/trim candidates:

| Candidate                                                                                                                                                                                                                                                                                        | Evidence                                                                                                                                                                                    | Effort | Implications                                                                                                                                         | Certainty |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| `packages/ui/src/components/terminal.tsx` and `terminal-xterm-overrides.css`                                                                                                                                                                                                                     | No live workspace imports. Brings `@xterm/*` and `partysocket` surface.                                                                                                                     | M      | Meaningful dependency reduction; verify no planned terminal feature depends on hidden export.                                                        | 92        |
| Unused shadcn inventory: `accordion`, `aspect-ratio`, `calendar`, `carousel`, `chart`, `command`, `context-menu`, `drawer`, `hover-card`, `input-group`, `kbd`, `menubar`, `navigation-menu`, `pagination`, `progress`, `radio-group`, `resizable`, `slider`, `switch`, `toggle`, `toggle-group` | Import graph found these unreachable from current workspace consumers. Several pull deps: `embla-carousel-react`, `react-day-picker`, `recharts`, `vaul`, `cmdk`, `react-resizable-panels`. | M      | Smaller install/bundle surface. Keep only if pre-seeded shadcn inventory is intentional, but then mark it as inventory and exclude it intentionally. | 88        |
| `packages/ui/src/components/events/stream-composer.tsx` and `packages/ui/src/components/ai-elements/prompt-input.tsx`                                                                                                                                                                            | `EventsStreamComposer` has no workspace consumers; OS uses app-local `agent-pill-composer.tsx`. These two files alone are 1,784 LOC.                                                        | M      | Removes a large unused AI input surface and duplicated primitive stack.                                                                              | 90        |
| Duplicate `ai-elements` primitives                                                                                                                                                                                                                                                               | Current direct external usage only needs `ai-elements/message`; primitives duplicate root shadcn components.                                                                                | M      | Keep `message` and maybe `conversation`; route primitive imports through canonical components.                                                       | 85        |
| `packages/ui/src/components/events/DESIGN-EXPLORATION.md` and `SLOT-PROTOTYPES.md`                                                                                                                                                                                                               | 916 LOC of docs describing migration from outlets to slots; current code already uses slots.                                                                                                | S      | Prevents agents from reviving obsolete event UI architecture.                                                                                        | 95        |
| `packages/ui/src/styles.css`                                                                                                                                                                                                                                                                     | Directory-local Knip reports unused; package export already maps `styles.css` to `src/styles/globals.css`.                                                                                  | S      | Removes alias confusion.                                                                                                                             | 95        |
| `packages/ui/src/styles/globals.css` `../../../services/*/src/ui` scan path                                                                                                                                                                                                                      | Repo has no `services` workspace.                                                                                                                                                           | S      | Faster/cleaner Tailwind scanning.                                                                                                                    | 90        |

Suggested end state:

- `packages/ui` exposes primitives, app providers, styles, and a small number of
  stable shared components.
- Product/domain event UI either moves into OS or into a separate,
  intentionally named package. It should not sit under generic `components`.

### 3. Shrink Remaining `packages/shared`

| Field        | Rating                                                                                                                         |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| Files        | `packages/shared/package.json`, `packages/shared/src/**`                                                                       |
| Effort       | M/L                                                                                                                            |
| Implications | Smaller public Interface, fewer shallow utilities, less accidental cross-app coupling. Need dependency and export-map updates. |
| Certainty    | 91                                                                                                                             |

Comment:

The package is live, but after the planned stream/callable/DO removal it still
contains old utility Modules with no external consumers. These should not stay
public just because they once felt shared.

Owner constraint:

`packages/shared` is also the natural place for platform contracts that should
span `apps/os` and `apps/auth`: auth claims/contracts, OAuth resource metadata,
signup allowlist behavior, app config parsing, Alchemy app wiring, and a future
event-log/EV-log style substrate. The target is not "make shared tiny at all
costs"; the target is "make shared contain real platform contracts instead of
miscellaneous utilities."

Concrete proposals:

| Candidate                                               | Evidence                                                                                                                                                                                                                                           | Action                                                                                                | Effort | Implications                                                                      | Certainty |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ------ | --------------------------------------------------------------------------------- | --------- |
| `packages/shared/src/project-ingress.ts` and `.test.ts` | 1,046 LOC. Exact import scan found no external consumers. Live ingress policy is in OS-local modules. Comments still describe old project/machine host vocabulary.                                                                                 | Delete, or re-home any still-valid invariant into OS.                                                 | S/M    | Custom hostname work may need concepts, but not this stale shared Interface.      | 90        |
| `packages/shared/src/type-tree/**`                      | 1,940 LOC including tests. No external imports. OS has narrower JSON schema handling in `apps/os/src/next/domains/itx/json-schema-types.ts`.                                                                                                       | Delete from shared. If ITX type generation returns, build it OS-local first.                          | M      | Plausible future leverage, but current leverage is zero.                          | 85        |
| `packages/shared/src/slug-maker.ts` and `.test.ts`      | No live consumers. Current slug usage goes through `slug` / `slugify` or app-local logic.                                                                                                                                                          | Delete.                                                                                               | S      | Removes funny-name generator from public shared surface.                          | 92        |
| `packages/shared/src/typeid.ts`                         | No live consumers. `docs/jonasland-rules.md` still points to it, but active auth/project IDs do not.                                                                                                                                               | Delete and update docs that instruct use of it.                                                       | S      | Drops `typeid-js` if no other consumer remains.                                   | 92        |
| `packages/shared/src/nitro-ws-response.ts`              | No live consumers. Nitro-specific wrapper in shared package.                                                                                                                                                                                       | Delete with `nitro` dependency if unused afterward.                                                   | S      | Low runtime risk.                                                                 | 88        |
| `packages/shared/src/test-helpers/**`                   | Public `./test-helpers` export has no exact imports. `test-support/vitest-e2e` is active and should stay.                                                                                                                                          | Delete or move helpers next to tests that need them.                                                  | S/M    | Future test convenience loss, but current CI does not use them.                   | 86        |
| `packages/shared/src/evlog/**`                          | Current exact import graph only needs the public `evlog`, `evlog/types`, and `evlog/orpc-plugin` style surface; no external imports of `/runtime` or `/stdout` were found. Owner also expects some EV-log/homespun-like direction to matter again. | Keep the code. Only prune or hide internal public subpaths after deciding the intended event-log API. | S/M    | Preserves a plausible platform substrate while still allowing export-map cleanup. | 78        |
| `packages/shared/src/node/run-command.ts` public export | File is used directly by `scripts/preview/preview.ts`; package export has no consumers.                                                                                                                                                            | Remove public export, or move file into `scripts/preview/lib`.                                        | S      | Low risk; direct import means file is not dead, only misplaced.                   | 80        |

Hard rule for future shared code:

Do not add a Module to `packages/shared` unless two non-test consumers exist
or the Interface is a true platform contract. "True platform contract" includes
auth/auth-contract semantics, app config parsing, shared app bootstrapping, and
event-log infrastructure intended to align OS and auth. Otherwise keep it
app-local.

### 4. Delete Non-OS Quarantine Code

| Field        | Rating                                                                                                                        |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| Files        | `packages/iterate/test-quarantine/**`, `apps/streams-example-app/test-quarantine/**`                                          |
| Effort       | M                                                                                                                             |
| Implications | Removes executable-looking reference code that imports old stream/UI surfaces. Convert useful notes to tasks before deleting. |
| Certainty    | 88                                                                                                                            |

Comment:

The user explicitly excluded OS quarantines; these are outside that exact area.
They are still plan-adjacent, so sequence them after the active cutover work if
needed.

`packages/iterate/test-quarantine/**` is 3,925 LOC. It is explicitly the
pre-itx-v4 stream browser TUI and imports legacy event UI contracts. The active
`packages/iterate/src/stream-tui/**` is now the agent chat TUI, not the legacy
stream browser.

`apps/streams-example-app/test-quarantine/**` is only 61 LOC, but still points
at old stream-engine surfaces and should be deleted or converted to a task.

Cleanup:

- Extract any still-needed parity bullets into tasks.
- Delete the quarantined source.
- Remove deps/devDeps that only existed for quarantined code.
- Add a lint/Knip rule that `test-quarantine` cannot be reintroduced without an
  explicit task and deletion date.

### 5. Clean `packages/iterate` Package Residue

| Field        | Rating                                                                                                                                                            |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Files        | `packages/iterate/package.json`, `packages/iterate/pubme.js`, `packages/iterate/src/worker.d.mts`, `packages/iterate/tsdown.config.ts`, `packages/iterate/src/**` |
| Effort       | M                                                                                                                                                                 |
| Implications | Smaller CLI package, fewer stale dependencies, clearer package entrypoints.                                                                                       |
| Certainty    | 84                                                                                                                                                                |

Comment:

Directory-local Knip reports:

- Unused file `pubme.js`.
- Unused file `src/worker.d.mts`, though `tsdown.config.ts` copies it into
  `dist`, so this may be a packaging convention rather than dead code.
- Unused deps: `better-auth`, `yaml`.
- Unused dev deps: `@iterate-com/auth-contract`, `@iterate-com/shared`,
  `@iterate-com/ui`, likely mostly because quarantined code is excluded from
  active entrypoints.
- Unlisted `cloudflare` in `src/worker.ts`.
- Unlisted binary `tsgo`.
- Unused exports/types such as `ConfigFile`, `formatSeconds`,
  `AgentConnection`, `AgentFeedModel`, and `StreamTuiPilottySpawnArgs`.

Cleanup:

- Delete `test-quarantine` first, then rerun Knip.
- Delete `pubme.js` if it is not part of the publish flow.
- Either make `src/worker.d.mts` an explicit packaging entry/copy artifact or
  delete the worker packaging path.
- Remove `better-auth`, `yaml`, and dev deps no longer needed after quarantine
  deletion.
- Add `cloudflare` / `tsgo` where actually required, or adjust scripts/types so
  Knip stops finding implicit dependencies.

### 6. Keep And Activate `packages/mock-http-proxy`

| Field        | Rating                                                                                                                       |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| Files        | `packages/mock-http-proxy/**`, `scripts/preview/preview.ts`, `docs/secrets-management-proposal.md`                           |
| Effort       | M/L                                                                                                                          |
| Implications | Turns a useful HAR/proxy tool into an owned test platform instead of deleting it while egress/refactor work is still moving. |
| Certainty    | 84                                                                                                                           |

Comment:

This package has good internal tests and typechecks, but no live workspace
consumer imports were found outside its own docs/package and preview path
filters. It overlaps with OS egress tests, but it is not the same thing:
active OS uses the Project Durable Object egress facet plus live RPC
interceptors and app-local HTTP fixtures, while this package provides generic
Node/MSW/MITM/HAR/WebSocket recording and replay. Keep it for now.

Directory-local Knip reports:

- Unused files:
  - `src/har/har-streaming-writer.ts`
  - `src/integration/http-client-scripts/openai-responses-websockets.raw-ws.ts`
  - `src/integration/http-client-scripts/openai-responses-websockets.ts`
  - `src/integration/http-client-scripts/slack-auth-test.ts`
- Unused deps/dev deps:
  - `@iterate-com/shared`
  - `https-proxy-agent`
  - `@slack/web-api`
  - `http-mitm-proxy`
  - `openai`
  - `tsx`
- Unused exports/types in HAR serialization and websocket bridge modules.

Cleanup direction:

1. Document the owner and intended use cases: real third-party egress capture,
   deterministic HAR replay, WebSocket transcript replay, and secret redaction
   checks.
2. Add it to root Knip with intentional ignores for scripts that are kept as
   operator tools.
3. Add one active consumer test or recipe where OS-local interceptors are not a
   replacement: for example OpenAI Responses WebSocket replay or a secret
   redaction regression over recorded traffic.
4. Only after that, prune unused integration scripts/files and deps that are
   confirmed not part of the kept operator workflow.

Recommended aggressive stance: give it one cleanup sprint to become active test
infrastructure. If that does not happen, delete it.

### 7. Clean `apps/iterate-com` Local UI And Content Drift

| Field        | Rating                                                                                                                     |
| ------------ | -------------------------------------------------------------------------------------------------------------------------- |
| Files        | `apps/iterate-com/backend/components/**`, `apps/iterate-com/backend/content/changelog/**`, `apps/iterate-com/package.json` |
| Effort       | M                                                                                                                          |
| Implications | Smaller marketing app, fewer duplicate UI systems, fixed changelog content path.                                           |
| Certainty    | 90                                                                                                                         |

Comment:

Directory-local Knip reports 873 LOC of unused local website UI/test utility
files:

- `backend/components/avatar.tsx`
- `backend/components/email-form.tsx`
- `backend/components/grid.tsx`
- `backend/components/hero-shuffle.tsx`
- `backend/components/mode-toggle.tsx`
- `backend/components/tasks-list.tsx`
- `backend/components/ui/badge.tsx`
- `backend/components/ui/button.tsx`
- `backend/components/ui/card.tsx`
- `backend/components/ui/not-found.tsx`
- `backend/components/ui/use-toast.ts`
- `backend/tests/home.todospec.ts`
- `backend/utils/cn.ts`

Some are clearly old composition leftovers. For example, `site-header.tsx`
keeps a commented `ModeToggle` import/use. `tasks-list.tsx` imports
`EmailForm`, but Knip reports `tasks-list.tsx` itself unused.

There is also a tracked broken changelog symlink:

- `apps/iterate-com/backend/content/changelog/CHANGELOG.md`
- symlink target: `../../../../../../../CHANGELOG.md`
- `test -e` fails and `wc` cannot open it.

The root `CHANGELOG.md` exists, but the symlink goes too far up the directory
tree. The changelog loader first tries the single-file symlink and then falls
back to per-date files. That is brittle.

Cleanup:

- Delete unused local UI files and remove resulting package deps.
- Fix the changelog by either:
  - deleting the broken symlink and using only per-date changelog files, or
  - correcting the symlink and adding a test/build check that it resolves.
- Remove duplicate toast/use-toast implementations if no route uses toasts.
- Decide whether the website should consume `@iterate-com/ui` or keep its own
  visual system. Do not leave both by accident.

### 8. Archive Stale Research And Heavy Markdown

| Field        | Rating                                                                                                                                                                                                                 |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Files        | `tasks/itx-v2-*.md`, `tasks/minimal-itx-v2-prd.md`, `docs/stage.md`, `docs/events.md`, `docs/secrets-management-proposal.md`, `tasks/doppler-shared-and-os-secrets-audit.md`, `packages/ui/src/components/events/*.md` |
| Effort       | M                                                                                                                                                                                                                      |
| Implications | Agents stop following deleted prototype paths and obsolete domain language.                                                                                                                                            |
| Certainty    | 90                                                                                                                                                                                                                     |

Comment:

There are 120 tracked markdown files under `docs`, `tasks`, `apps`, and
`packages`, totaling about 17,290 LOC, plus agent-skill markdown. Some of it is
valuable. Some is stale enough to actively mislead agents.

High-confidence archive/delete candidates:

| Candidate                                                                                                                                                                                                          | Evidence                                                                                                                                                           | Action                                                                                                 | Effort | Certainty |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ | ------ | --------- |
| `tasks/itx-v2-clean-refactor-research.md`, `tasks/itx-v2-cleanup-fix-research.md`, `tasks/itx-v2-domain-vs-itx-surface-cleanup.md`, `tasks/itx-v2-reference-simplification-plan.md`, `tasks/minimal-itx-v2-prd.md` | 1,685 LOC pointing to deleted/nonexistent `apps/minimal-itx-v2`.                                                                                                   | Move to `tasks/complete/archive/` or delete if no longer useful.                                       | S      | 95        |
| `docs/stage.md`                                                                                                                                                                                                    | Says only first section is current; the rest is legacy.                                                                                                            | Merge current bullets into `docs/devops-cloudflare-doppler-alchemy-setup.md`; delete legacy remainder. | S      | 92        |
| `docs/events.md`                                                                                                                                                                                                   | Still says OS processors live in `apps/os/src/domains/*/stream-processors` and `apps/os/src/domains/streams`. Current code is under `apps/os/src/next/domains/**`. | Rewrite to describe the current processor model or mark historical.                                    | S/M    | 88        |
| `docs/secrets-management-proposal.md`                                                                                                                                                                              | Historical banner, stale path `apps/os/src/domains/projects/egress-secret-substitution.ts`, and old design language.                                               | Move to `docs/history` or update the banner with current paths and status.                             | S      | 85        |
| `tasks/doppler-shared-and-os-secrets-audit.md`                                                                                                                                                                     | Draft from 2026-05-18 with Clerk/static OAuth references and `os` rename confusion.                                                                                | Run/complete/archive, or rewrite against current auth-worker config.                                   | S/M    | 84        |
| `packages/ui/src/components/events/DESIGN-EXPLORATION.md` and `SLOT-PROTOTYPES.md`                                                                                                                                 | 916 LOC of old UI migration/exploration docs.                                                                                                                      | Delete after preserving any current decisions in `CONTEXT.md`.                                         | S      | 95        |

Rule:

Task/research docs that point to deleted prototype paths should either be in a
clearly historical archive or gone. Keeping them beside active tasks makes
agents recover dead designs.

### 9. Tighten Generated Route Tree Checks Outside OS

| Field        | Rating                                                                                                                                    |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Files        | `apps/auth/src/routeTree.gen.ts`, `apps/semaphore/src/routeTree.gen.ts`, `apps/streams-example-app/src/routeTree.gen.ts`, package scripts |
| Effort       | M                                                                                                                                         |
| Implications | Prevents non-OS app route drift.                                                                                                          |
| Certainty    | 78                                                                                                                                        |

Comment:

OS has `routes:check`; other tracked generated route trees do not have an
obvious equivalent guard. Current import counts look plausible, but drift is
unguarded.

Cleanup:

- Add route-tree generation/check scripts to auth, semaphore, and
  streams-example app, or stop tracking generated route trees consistently.
- Include the checks in root `typecheck` or app-specific CI.

### 10. Make Root Specs Fail When Coverage Is Expected

| Field        | Rating                                                                                                                                   |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Files        | `specs/signup.spec.ts`, `specs/create-project.spec.ts`, `specs/test-support/email-otp-signup.ts`, `specs/test-support/forged-session.ts` |
| Effort       | M                                                                                                                                        |
| Implications | Prevents key smoke tests from silently becoming no-ops.                                                                                  |
| Certainty    | 82                                                                                                                                       |

Comment:

Root Playwright signup/create-project specs dynamically skip when email OTP is
disabled. That is fine for production-compatible smoke, but bad for a lane that
is supposed to exercise signup. The helper also bypasses missing UI sign-in
button state by navigating to login URLs.

Cleanup:

- Split prod-compatible smoke from dev/preview signup coverage.
- Add preflight failure when a CI lane expects email OTP.
- Make skipped tests issue-linked or task-linked.

### 11. Decide Active Skipped/Failing E2E Specs

| Field        | Rating                                                                                                                                                        |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Files        | `apps/os/e2e/engine/stream-lifecycle-failing.e2e.test.ts`, `apps/os/e2e/engine/itx.e2e.test.ts`, `apps/streams-example-app/e2e/vitest/stream-capnweb.test.ts` |
| Effort       | S/M                                                                                                                                                           |
| Implications | Reduces pseudo-coverage and makes failure state explicit.                                                                                                     |
| Certainty    | 80                                                                                                                                                            |

Comment:

This is not about OS quarantine; these are active-looking specs with permanent
skips, env-gated skips, or `it.fails`. One skipped test reportedly has a
"maybe dumb vibecoded test" comment.

Cleanup:

- Convert skipped tests to issue-linked `it.fails` if they describe real broken
  behavior.
- Port behavior into lower-level tests if e2e is the wrong layer.
- Delete obsolete tests.

### 12. Clean Lint Rules After Shared Deletions

| Field        | Rating                                                    |
| ------------ | --------------------------------------------------------- |
| Files        | `lint/oxlint-plugin-iterate.ts`, lint tests               |
| Effort       | S                                                         |
| Implications | Prevents deleted shared subpaths from being reintroduced. |
| Certainty    | 88                                                        |

Comment:

The lint allowlist still permits old shared paths such as callable descriptor
types and shared stream types. Those are plan-covered deletions, but the lint
cleanup is a separate guardrail.

Cleanup:

- Remove regex entries for deleted shared subpaths.
- Add lint-rule tests asserting those old imports are rejected.

### 13. Reduce Root Workspace And Script Ambiguity

| Field        | Rating                                                                                                        |
| ------------ | ------------------------------------------------------------------------------------------------------------- |
| Files        | `pnpm-workspace.yaml`, `package.json`, `scripts/package.json`, `.github/ts-workflows/package.json`, `knip.ts` |
| Effort       | S/M                                                                                                           |
| Implications | Less false positive noise from tools.                                                                         |
| Certainty    | 85                                                                                                            |

Comment:

`pnpm exec knip --dependencies --no-exit-code` currently reports package
ownership issues even though root `pnpm knip` is clean for configured
workspaces.

Concrete findings:

- `pnpm-workspace.yaml` lists `apps/iterate-com`, `apps/os`, and
  `apps/semaphore`, then also `apps/*`. The explicit entries are redundant
  unless they are documentation.
- `knip.ts` has stale ignores/no-match patterns according to the package-graph
  audit. Clean those until dependency-mode Knip reports only real findings.
- Directory-local Knip reports many script/workflow files unused because they
  are invoked by package scripts or dynamic imports. Model these as entries or
  keep them out of generic Knip.
- `scripts/preview/preview.ts` imports `runCommand` directly from shared source
  rather than through a package interface. Move the helper into scripts or make
  the package export intentional, not both.
- Root `package.json` is reported with unused dependencies `@octokit/rest` and
  `@orpc/client`. `scripts/preview/preview.ts` uses `@octokit/rest`, but that
  package belongs to `scripts/package.json`, not root.
- Root ESLint-era dev deps are reported unused: `@tanstack/eslint-plugin-router`,
  `eslint-plugin-codegen`, `eslint-plugin-eslint-comments`,
  `eslint-plugin-import`, `eslint-plugin-unicorn`, and `esquery`. Active repo
  lint is `oxlint`; the custom lint package imports `esquery` and
  `eslint-plugin-unicorn` via root leakage.
- `scripts/package.json` reports unused `@orpc/server`; verify and remove if
  truly unused.
- `pnpm-workspace.yaml` catalog has unused Cloudflare entries:
  `@cloudflare/unenv-preset`, `@cloudflare/vitest-pool-workers`,
  `@cloudflare/worker-bundler`, and `workerd`.

Cleanup:

- Move dependencies to the package that imports them.
- Add package-local deps for dynamic tool entrypoints where appropriate.
- Remove root deps that exist only because another package accidentally leaks
  through workspace resolution.

### 14. Fix Package And Patch Defects

| Field        | Rating                                                                                                                                          |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Files        | `patches/**`, `apps/iterate-com/package.json`, `lint/package.json`, `packages/shared/tsconfig.json`, `apps/os/iterate-config-repo/package.json` |
| Effort       | M                                                                                                                                               |
| Implications | Tooling becomes honest: active patches are active, package exports resolve, package-local checks stop depending on root leakage.                |
| Certainty    | 90                                                                                                                                              |

Comment:

The package graph has several high-confidence defects that are not about
runtime code, but they make the repo harder to reason about.

Concrete proposals:

| Candidate                          | Evidence                                                                                                                                                                                                             | Action                                                                                          | Effort | Implications                                                           | Certainty |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ------ | ---------------------------------------------------------------------- | --------- |
| Inactive Better Auth Drizzle patch | `patches/@better-auth__drizzle-adapter.patch` exists, but `pnpm-workspace.yaml` `patchedDependencies` does not list `@better-auth/drizzle-adapter`. No active source refs found outside lockfile.                    | Delete the patch if obsolete; otherwise add it to `patchedDependencies`.                        | S      | Avoids false confidence that the patch is applied.                     | 95        |
| Broken website package export      | `apps/iterate-com/package.json` exports `"."` as `./manifest.ts`, but `manifest.ts` does not exist and no in-repo imports of `@iterate-com/website` were found.                                                      | Remove the export or add the intended manifest.                                                 | S      | Fixes invalid package surface.                                         | 98        |
| Lint package dependency boundary   | `lint/oxlint-plugin-iterate.ts` imports `esquery` and `eslint-plugin-unicorn`; `lint/package.json` does not declare them. It does declare unused `@typescript-eslint/types` and likely unnecessary `@types/esquery`. | Move real deps into `lint/package.json`; remove unused lint deps from root and lint package.    | M      | `pnpm --dir lint typecheck/test` becomes independent of root leakage.  | 80        |
| Stale shared tsconfig excludes     | `packages/shared/tsconfig.json` still excludes deleted callable config files and old `src/codemode/vitest.config.ts`.                                                                                                | Delete no-longer-matching excludes.                                                             | S      | No behavior change; less migration debris.                             | 95        |
| Nested config repo package         | `apps/os/iterate-config-repo/package.json` is a standalone 134 LOC fixture/config repo. `pnpm --dir ... typecheck` works, but it is not a workspace package.                                                         | Either keep it intentionally standalone and document it, or add it to workspace/CI with a name. | M      | Prevents fixture code from silently rotting outside workspace tooling. | 70        |

### 15. Post-Cleanup Dependency Pass

| Field        | Rating                                                                            |
| ------------ | --------------------------------------------------------------------------------- |
| Files        | `package.json`, `pnpm-lock.yaml`, affected workspace package manifests            |
| Effort       | M                                                                                 |
| Implications | Lockfile churn; biggest install-time wins come after UI and quarantine deletions. |
| Certainty    | 90                                                                                |

Comment:

Do dependency removal after source deletion, not before. Expected removals if
the above cuts land:

- From `packages/ui`: `@xterm/*`, `partysocket`, `embla-carousel-react`,
  `react-day-picker`, `recharts`, `vaul`, `cmdk`,
  `react-resizable-panels`, `@iterate-com/shared`, maybe `date-fns`, maybe
  duplicated ai-element support deps.
- From `packages/shared`: `typeid-js`, `nitro`, maybe `get-port` if
  `test-helpers` dies.
- From `packages/iterate`: `better-auth`, `yaml`, and dev deps only retained
  by quarantine.
- From `packages/mock-http-proxy`: do not remove HAR/MITM/WebSocket replay
  dependencies just because no external package imports them yet. First decide
  the kept operator/test workflow, then remove only deps unused by that
  workflow. `@iterate-com/shared` is still a likely removal if exact import
  scans stay empty.
- From `apps/iterate-com`: local UI deps that only supported deleted components.
- From root: `@octokit/rest`, `@orpc/client`, ESLint-era dev deps, and unused
  Cloudflare catalog entries once package-local ownership is fixed.

## Suggested Sequencing

### Wave 0: Guardrails First

1. Add Knip workspace configs for omitted workspaces.
2. Add route-tree check scripts for non-OS TanStack apps.
3. Fix Alchemy/Vite side effects so Knip can audit `apps/auth` without local
   `.alchemy` state.

Expected result: dead-code checks become repeatable.

### Wave 1: Safe Deletes

1. Delete stale UI docs and `packages/ui/src/styles.css`.
2. Delete broken `apps/iterate-com` changelog symlink or fix it.
3. Archive itx-v2/minimal-itx-v2 task docs.
4. Delete `docs/stage.md` legacy remainder after moving current note.
5. Audit shared public exports for `evlog/runtime`, `evlog/stdout`, and
   `node/run-command`. Remove `node/run-command` if no public consumers exist;
   defer `evlog` export pruning until the intended EV-log API is clear.

Expected result: low-risk documentation and export cleanup.

### Wave 2: Medium-Risk Code Removal

1. Delete unused `packages/ui` terminal stack.
2. Delete unused `packages/ui` shadcn inventory and deps.
3. Delete `packages/ui` stream composer/prompt-input stack.
4. Delete shared zero-consumer helpers:
   `project-ingress`, `type-tree`, `slug-maker`, `typeid`,
   `nitro-ws-response`, and unused `test-helpers`.
5. Delete unused `apps/iterate-com` local components.

Expected result: large LOC and dependency reduction with manageable blast
radius.

### Wave 3: Ownership Decisions

1. Keep `packages/mock-http-proxy`; decide its owner, active test use case,
   and intentional Knip ignores.
2. Delete `packages/iterate/test-quarantine` after preserving useful notes.
3. Delete `apps/streams-example-app/test-quarantine`.
4. Decide where product stream UI belongs after the active OS cutover: OS-local
   or a narrower stream UI package, not generic `packages/ui`.

Expected result: fewer pseudo-packages and fewer reference-only source trees.

### Wave 4: Dependency And Lockfile Sweep

1. Remove unused dependencies from package manifests.
2. Regenerate lockfile.
3. Run:
   - `pnpm install`
   - `pnpm knip`
   - `pnpm typecheck`
   - `pnpm test`
   - targeted package tests for modified packages.

## Highest-Confidence Immediate PR

If this needs to become one cleanup PR tomorrow, make it:

1. Add `packages/ui` to Knip.
2. Delete:
   - `packages/ui/src/components/events/DESIGN-EXPLORATION.md`
   - `packages/ui/src/components/events/SLOT-PROTOTYPES.md`
   - `packages/ui/src/styles.css`
3. Fix/delete the broken `apps/iterate-com/backend/content/changelog/CHANGELOG.md` symlink.
4. Archive `tasks/itx-v2-*.md` and `tasks/minimal-itx-v2-prd.md`.
5. Audit stale public shared exports, but do not delete `evlog` code in this
   PR; defer event-log API cleanup until the OS/auth shared-contract direction
   is explicit.
6. Delete or activate `patches/@better-auth__drizzle-adapter.patch`.
7. Remove the invalid `apps/iterate-com` `./manifest.ts` export.

That PR is small, should not affect runtime behavior, and sets up the bigger
deletion work with better tooling.
