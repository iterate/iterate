---
state: todo
priority: high
size: medium
tags: [os, testing, e2e, lint, strategy]
---

# Testing strategy: decision log + change backlog

Working document for the testing-strategy effort (branch `testing-strategy`,
audit 2026-07-14). Decisions get dated entries; backlog items graduate into
PRs and get checked off. The end state is a rewritten
[docs/testing.md](../docs/testing.md) that names the philosophy explicitly —
this file tracks how we get there.

## Decisions

- **2026-07-14 — vitest e2e and Playwright specs are sibling lanes.** Same
  operational contract (Doppler config supplies the deployment, budgets from
  `e2e-policy/budgets.ts`, one retry in CI, retry telemetry, artifact
  collection); they differ only in assertion surface — itx API vs real
  browser. Keep both runners: middlewright is Playwright-native and porting
  it would risk the spinner-waiter for aesthetics. Any browser-driving that
  isn't Playwright must justify itself.
- **2026-07-14 — bring back the disarmed lint rules**, considered
  individually (table below).
- **2026-07-14 — verdict: arm all of them.** First PR in flight
  (`rearm-e2e-lint-rules`): re-arms every rule per the proposed scopes,
  fixes violations, adds the scope-liveness guard. The no-describe
  flattening rides in its own commit so it can be dropped if the rationale
  doesn't hold up (Jonas asked "why no describe" — answer: flat files are
  the specs-as-specs doctrine; the wrapper restates the filename, and
  describes are where closure state + lifecycle hooks breed, which fights
  test-owns-its-state and the retry policy).
- **2026-07-14 — unit-test bar: tables + tiny kernels** (grilling round 1).
  Wide case tables (processor harnesses, incident repros) plus
  zero-maintenance adversarial/security kernels earn unit tests; delete
  only what actively lies (tautology, pinning, mock theater).
- **2026-07-14 — ship gate: per-artifact hard rules.** Processor ⇒ harness
  suite with refold + eviction; itx capability ⇒ catalogue example;
  product flow ⇒ spec; incident fix ⇒ captured-journal repro. Absence is
  a review blocker. Now drafted into docs/testing.md.
- **2026-07-14 — deletions deferred** (Jonas: "discuss what to delete
  later"). The LLM-in-e2e question got superseded by a better framing from
  Jonas: **test dimensions** — surface (browser/node), speed, determinism,
  cost (pays for LLM turns), remote reach — as first-class controllable
  axes, while still using vanilla vitest/playwright CLIs "Misha style".
  Draft proposal now lives in docs/testing.md § "Test dimensions (DRAFT)";
  grilling round 2 queued on its open questions.

## How the lint enforcement got disarmed (for the record)

Two events, both collateral damage inside large refactors — nobody decided
to turn the rules off:

1. **PR #1341** (2026-05-18, "Remove legacy OS1 stack") deleted the
   `spec/**` override block from `.oxlintrc.json`, taking
   `iterate/spec-restricted-syntax` and the forced
   `@playwright/test` → wrapped-`test` import redirect with it. When the new
   root `specs/` lane was built days later (#1556), the block was never
   re-created.
2. **PR #1488** (2026-06-15, "Delete oRPC stack 2/2") deleted
   `apps/os/e2e/vitest/agents.e2e.test.ts` — the single pilot file the
   #1361 test-style rules were scoped to. `.oxlintrc.json:261` still points
   at the ghost path today; the rules run against nothing.

All seven rule implementations survive in `lint/oxlint-plugin-iterate.ts`,
so re-arming is config-only plus violation fix-ups. Lesson encoded below as
the scope-liveness guard.

## Rule-by-rule reconsideration

Violation counts measured 2026-07-14. "Verdict" column is for Jonas.

| Rule (`lint/oxlint-plugin-iterate.ts`)                                               | Enforces                                                                                                                                                 | Violations today                                                                                                                                            | Proposed scope                                                                                                                                                                                                                                        | Verdict |
| ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| `prefer-test-over-it` (:971)                                                         | `test(...)` not `it(...)`                                                                                                                                | 2–3 sites, all in `e2e/examples/examples-browser.test.ts`                                                                                                   | `apps/os/e2e/**` + unit lanes (near-zero cost)                                                                                                                                                                                                        |         |
| `no-lifecycle-hooks` (:724)                                                          | No `beforeEach`/`afterAll` etc.; disposable fixtures (`Symbol.asyncDispose`) instead                                                                     | **0** in `apps/os/e2e/**`                                                                                                                                   | `apps/os/e2e/**`, `specs/**` — free win. Unit lane has 29 uses; decide separately                                                                                                                                                                     |         |
| `no-vi-mock` (:768)                                                                  | No `vi.mock`; DI / controllable fakes at the product boundary                                                                                            | **0** in `apps/os/e2e/**`                                                                                                                                   | `apps/os/e2e/**`, `specs/**` — free win. Unit lane has 24 uses (9 in `scripts/deploy.test.ts` = the mock-theater cluster); arming there forces per-file disables, i.e. mocking becomes a visible commented decision — separate call                   |         |
| `no-describe` (:747)                                                                 | Flat files; the first readable unit is a test                                                                                                            | 20 calls across 19 e2e files (mostly single top-level wrappers)                                                                                             | `apps/os/e2e/**` after a mechanical flattening pass. Caveat: `describe.skipIf` env-gating (e.g. Slack suite) converts to `test.skipIf` per test or gets a commented disable. NOT for the unit lane (269 uses; `describe.for` is a documented pattern) |         |
| `helpers-after-tests` (:913)                                                         | Helpers/fixture builders below the tests; file opens with behavior                                                                                       | unknown — needs a dry run                                                                                                                                   | `apps/os/e2e/**`, `specs/**`                                                                                                                                                                                                                          |         |
| `prefer-object-property-match` (:944)                                                | `expect(obj).toMatchObject({p})` over `expect(obj.p).toBe(...)` — failure shows the whole object                                                         | unknown — needs a dry run                                                                                                                                   | `apps/os/e2e/**`, `specs/**`                                                                                                                                                                                                                          |         |
| `spec-restricted-syntax` (:1111)                                                     | Playwright dialect: no awaited `expect(...)` (locators + `.waitFor()`; `expect.poll` OK), no `toBe(true/false)`, no `waitForURL`, no `baseURL` in `goto` | `specs/`: 3× `waitForURL` (signup/create-project redirect waits), 5× `toBe(true/false)`, 6× `waitForTimeout`\* all in `stream-resume-after-suspend.spec.ts` | `specs/**`. \*The suspend spec waits through windows with deliberately no UI progress — that file gets a commented disable, which is exactly the escalation rule (#1791) working                                                                      |         |
| `no-restricted-imports` on `@playwright/test#test` (plain oxlint config, not plugin) | Specs must use the wrapped `test` (spinner-waiter, hydration, error reporter)                                                                            | 0 — 17/17 specs comply socially; only `specs/test-support/test.ts` imports raw (it IS the wrapper → exempt)                                                 | `specs/**`, message updated to point at `specs/test-support/test.ts`                                                                                                                                                                                  |         |

**MERGED 2026-07-14 as `db8917f15`** — all seven rules + the
scope-liveness guard are live on main. During babysitting, the merge from
main brought in two repo-IDE specs whose 20s web-first waits the
newly-armed `spec-restricted-syntax` immediately caught (kept behind
reasoned disables — the rule working on day one); the final red check was
a Depot provisioning failure (no logs produced), fixed by `depot ci
rerun`. Bugbot passed; zero unresolved threads.

**Outcome — PR #1965 (2026-07-14):** everything armed except
`prefer-object-property-match` on the e2e block — the dry run found **92**
sites, tripping the >50-sites escape valve — then Jonas called it: fixed
and armed in a follow-up commit on the same PR (e9d3500a8; see below). `spec-restricted-syntax` was bigger
than estimated: 30 sites, because the rule flags bare `expect()` under any
`AwaitExpression` ancestor — including sync expects inside awaited
`spinnerWaiter.settings.run(...)` closures; 23 rewritten to locator waits,
7 kept via commented disables in the suspend repro. `describe.skipIf`
gates became per-test `test.skipIf`. Collected test counts preserved
(vitest e2e 135→135, playwright 49→49 — script-verified 1:1 mapping).
Bonus: the scope-liveness guard exposed **10 pre-existing dead globs** in
`.oxlintrc.json` (`startups/**`, `**/*.jsx`, `**/test-utils.ts`, …) —
removed with zero behavior change.

Related but not a rule: `toBe(true/false)` also appears **36×** in the
vitest e2e lane (`workspace.itx` 8, `live-state` 4, `itx-egress` 4, long
tail 1–2). If we want that ban outside Playwright specs, either extend
`spec-restricted-syntax`'s scope or lean on `prefer-object-property-match`
— decide during the dry run.

**The scope-liveness guard (do regardless of verdicts):** a unit test in the
same genre as `scripts/preview/e2e-policy.test.ts` asserting every
`overrides[].files` glob in `.oxlintrc.json` matches ≥1 real file. An
exact-filename scope survives human refactors but not AI ones; this makes a
dead scope a red build instead of a silent no-op.

## Helper geography (PR #1993 delivers this — awaiting review)

**PR #1993** (branch `test-helper-geography`, not merged): charter section
in docs/testing.md (truth fix: L1 spans TWO homes — dev-server in
`apps/os/scripts/`, forge at repo-root `scripts/auth/`), forge-signer
dedupe (~80-line WebCrypto fork deleted; claims field-identical; typ:JWT
header gap closed by extending forge-token; cookie expiry now derived
from token exp; live-proven via dashboard + REPL specs and a real
auth:mint 302), fixture-slug L0 module (found THREE copies, not two —
os-client `uniqueSuffix` was the third), and the video-mode docs (Part D
below). Bonus doc'd gotcha: repo-root `doppler run --config dev -- pnpm
spec` resolves `_shared` and its DOPPLER_PROJECT poisons the specs'
nested os-secrets download.

**Video-mode truth (Jonas asked 2026-07-14):** the automatic part is
recording/rendering only (middlewright `videoMode`: pointer highlights,

> 300ms dead-air speed-up, auto trimStart; output
> `test-results/playwright-output/<test>/video-rendered.webm`, needs
> ffmpeg). PR attach is MANUAL: webm→mp4, drag into the GitHub web editor
> (mints the `user-attachments` URL — the only host GitHub's `<video>`
> sanitiser allows; no API/gh upload route). Backlog option if we ever
> want true automation: release-asset GIF/mp4 route like #1764.

Original proposal for reference:

Four layers; a helper lives at the LOWEST layer all its consumers share.
Imports point down only. Needed by both lanes ⇒ move down, never copy
sideways.

| Layer                     | Home                                                                                  | Charter                                                                                                                       | Today                                                                               |
| ------------------------- | ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| L0 policy/infra           | `packages/shared/src/test-support/`                                                   | Runner-agnostic: budgets, retry telemetry, artifacts (+ proposed: fixture slug/disposal convention)                           | e2e-policy, vitest-e2e                                                              |
| L1 environment & identity | `apps/os/scripts/`                                                                    | Dev-server lifecycle (`dev.ts`, `dev-server-info.ts`), doppler plumbing, auth forge (`scripts/auth/forge-token.ts`)           | already consumed by BOTH lanes (playwright webServer, #1987 globalSetup, auth:mint) |
| L2 surface clients        | `apps/os/e2e/test-support/` (itx surface) and `specs/test-support/` (browser surface) | Lane-specific: os-client/create-test-project/tunnel/mock-slack vs middlewright test wrapper/forged-session fixture/OTP signup | mostly right                                                                        |
| L3 domain harnesses       | `apps/os/src/domains/*/test-helpers.ts`, colocated                                    | Unit-lane fakes implementing real interfaces; never imported by L2+                                                           | `streams/test-helpers.ts` canonical since PR #1988                                  |

Known violations / moves:

1. **Forge signing duplicated** — `specs/test-support/forged-session.ts`
   has its own `signJwt` (:271) and does NOT import
   `scripts/auth/forge-token.ts` (which auth:mint uses). Converge on
   forge-token as the one signer; forged-session keeps only the
   browser/cookie/fixture layer. (specs already imports from
   apps/os — `doppler` from scripts/dev.ts, `connectItx` — so the
   downward dependency is established practice.)
2. **Fixture convention split** — `create-test-project.ts` (admin-itx
   authority) and `createProjectFixture` (forged-session authority) are
   parallel BY DESIGN, but slug shape / DNS trimming / `await using`
   disposal semantics should be one L0 module so they stop drifting.
3. `wait-for-condition.ts` (L2 e2e) is generic → promote to L0 only when
   a spec needs it.
4. #1988 survey items (connect-flow hoisted fakes incl. github-connect
   offset-numbering drift, MemoryKv/FakeKv) are L3 work — consolidate
   colocated, do NOT lift into shared.

Anti-goal: one mega test-support package — it would drag itx clients and
forge machinery into a package workers import, and distance helpers from
their lanes. Charter over centralization.

## Backlog

### Sibling-lane alignment (follows from decision 1)

- [x] `pnpm e2e` auto-starts the local dev server mirroring `pnpm spec`'s
      webServer semantics (no-op on deployed target / reuse live / start
      detached / never boot in CI; no new env vars) — **PR #1987**,
      live-proven incl. cold browser-project 26/26 (port coherence via a
      config-eval `Symbol.for` stash shared with globalSetup — review
      that mechanism). Awaiting Jonas review; NOT merged.
- [x] Root `pnpm e2e` alias — same PR #1987.
- [x] specs-at-repo-root rationale written into specs/AGENTS.md — same
      PR #1987.
- [ ] Decide the vitest **browser project**
      (`e2e/examples/examples-browser.test.ts`): third browser driver,
      local-only, preview coverage already delegated to
      `specs/repl-examples.spec.ts`. Kill or demote to explicit manual
      probe. (Killing it also removes the only `it(` sites in e2e.)

### Quick mechanical fixes (doc/config drift from the audit)

- [x] Re-point `.oxlintrc.json:261` per the verdicts above (globs, never
      exact filenames) + add the scope-liveness guard — **PR #1965**.
- [x] `docs/testing.md` ladder row: `OS_PREVIEW_VITEST_LANE_TIMEOUT_SECS`
      360s → the constant is now `OS_PREVIEW_LANE_TIMEOUT_SECS` = 480s.
- [x] `docs/testing.md` says the spinner-waiter lives in `patches/` — it's
      the `middlewright` npm dep since #1813.
- [x] `apps/os/e2e/AGENTS.md` still describes the pre-split
      `itx.e2e.test.ts` monolith.
- [x] Prune 5 dead entries from `observedFileSeconds` in
      `apps/os/e2e/vitest.config.ts` (files renamed/deleted).
- [x] Delete the `**/*.workerd.test.ts` exclude glob (zero matching files) —
      the doctrine decision (catalog pins, docs) is still open below.

(All five done 2026-07-14 on branch `testing-strategy`, uncommitted —
they ride the next PR out of this branch.)

### Decisions wanted (each a short conversation)

- [ ] **dummy-petshop unit lane has no retry wiring**: `github-app.test.ts`
      ("deliver mode POSTs the x-hub-signature-256 header") flaked red with
      "Error: bad port" on 2026-07-14 (port race binding its local webhook
      receiver) and there is no `E2E_CI_RETRIES`/retry config on
      `apps/dummy-petshop/vitest.config.ts` — one flake reds the whole Test
      lane. Either wire the policy retry like the os configs or fix the
      port allocation to bind port 0.

- [x] **`prefer-object-property-match` on the e2e lane** — armed, all 91
      sites fixed in PR #1965 commit e9d3500a8 (3 parallel subagents on
      disjoint file sets): 81 rewritten (adjacent asserts on one receiver
      merged into single `toMatchObject` calls), 10 kept behind
      reasoned `oxlint-disable-next-line` comments where exhaustive
      `toEqual`/frozen-state exactness is deliberate — incl. the
      result-spill test, where printing the whole object on failure would
      mean 10MB diffs (the rule's goal inverted). Collected count 135
      unchanged; lint 0/0; typecheck green.

- [x] **Workerd doctrine, explicitly** — drafted as Philosophy §6 in
      docs/testing.md; the dead `@cloudflare/vitest-pool-workers` catalog
      pin + its release-age exclude deleted (lockfile unchanged = provably
      unconsumed). Audit CORRECTION: miniflare IS consumed
      (`catalog:cloudflare` dep of os/auth/semaphore) and stays; workerd
      pin left alone. Remaining: Jonas ratifies the doctrine wording.
- [ ] **Dead lanes**: `apps/os/runtime-smoke.test.ts` (CI-skipped,
      unwired), `apps/os/e2e/playwright/` + `apps/os/playwright.config.ts`
      (wired into nothing). Wire, mark as manual probes, or delete — each
      individually.
- [ ] **Auth real-OAuth gap**: forged sessions bypass the code exchange
      (incident class: streams.iterate.com stale registrations); auth's
      preview "e2e" is one curl of the discovery doc. Cheapest fix: one spec
      through the genuine OAuth flow per preview run.
- [ ] **Prompt/template pinning policy**: budgets + referential integrity
      YES (`agent-prompt-budgets.test.ts` is the good version); copy pinning
      NO. Then delete: prompt `toContain` batteries
      (`agent-processors.test.ts:56-79`), most of
      `exec-typescript-description.test.ts` (keep the positional truncation
      invariants), the string anchors in `config-repo-template.test.ts`
      (keep structural asserts), constant restatements in
      `subscriber-math.test.ts:19-27`.
- [ ] **`scripts/deploy.test.ts` mock theater** (9× `vi.mock`): slim to the
      security kernels (forbidden-service-token, exact-project-miss).
- [ ] **Internal-CLI arg tests** (`cli.test.ts`, `session.test.ts`,
      `itx.test.ts`, ~320 LOC): docs/testing.md explicitly disclaims these;
      delete, keeping `session.ts`'s authority-mode guard.
- [ ] **Dated-skip convention**: `test.skip` marked "KNOWN GAP" needs an
      owner/expiry or it rots (`stream-lifecycle.e2e.test.ts:520`).

### Larger refactors

- [x] **Consolidate the harness copies** — **PR #1988** (awaiting review,
      not merged): SIX duplicates found (audit's five + project-processor + scheduler-processor), and `agents/test-helpers.ts` was itself a
      second "canonical" — now deleted; `streams/test-helpers.ts` is the
      single home. Net **−851 LOC**; test counts byte-identical (1410).
      Load-bearing clock divergences kept as explicit `now` pins with
      comments (telegram refold stale-read; github `now: () => 10`);
      `failAppendsOfType` promoted to canonical. Three latent hazards
      flagged in the old copies (epoch createdAt staleness, stubbed
      `getEvent`, creating-`eventsAt` corruption). Original plan text:
      4–5 near-identical
      `MemoryStreamNetwork`/`MemoryStream` re-implementations (~400 LOC) in
      slack/email/telegram/github suites → import the shared harness
      (`apps/os/src/domains/agents/test-helpers.ts`,
      `streams/test-helpers.ts`). Protects the single best test asset from
      fake-drift.
- [ ] **The strategy doc itself**: rewrite docs/testing.md with a named
      philosophy section — the spinner-waiter incentive loop (Misha; quote
      the middlewright README), specs-as-product-specs (`specs/AGENTS.md`),
      fresh-project-per-test isolation, the one-retry ladder, harness-
      fidelity honesty (the `stream-subscribers.teardown` pattern), the
      no-workerd doctrine. Fold or retire `docs/vitest-patterns.md` (it
      recommends inline snapshots; the corpus has exactly one).
- [ ] **`llmRecover`**: Misha's soft-fail LLM-recovery middlewright plugin
      is dormant (not wired in `specs/test-support/test.ts`). Revive or
      retire.
- [ ] **Shared-helpers round 2** (from PR #1988's survey): connect-flow
      `vi.hoisted` binding fakes (github-connect / telegram-connect /
      google-connection) re-implement STREAM/SECRET seams with divergent
      offset semantics — github-connect's fake numbers a 2-event batch
      2,3 on append but 1,2 on getEvents (same drift class the
      consolidation killed); duplicate Map-backed KV fakes (`MemoryKv`
      vs `FakeKv`); copy-pasted `vi.mock` egress bundles across
      integration suites.

## Audit reference (compressed)

~213 test files / ~46k LOC. Unit lane (vitest node, colocated) 146 files /
33.9k LOC — top six files are the stream-processor/fold harness suites
(~9k LOC, the deliberate docs/testing.md exception). OS e2e (vitest vs live
deployment) 42 / 9.8k. Root Playwright specs 17 / 1.5k. Auth 7 / 807 via
`node --test`. Genuinely low-value material ≈1.5k LOC (pinning, mock
theater, CLI arg tests, dead lanes). Full audit report: chat session
2026-07-14; Misha attribution evidence: middlewright README + repo,
`specs/AGENTS.md` (100% his), PRs #1122/#1340/#1361/#1556/#1560/#1564/
#1567/#1570/#1791.
