---
status: in-progress
size: medium
branch: publish-iterate-sdk
---

# Publish `iterate` with an `iterate/sdk` export; template consumes it via pkg.pr.new

## Status summary

Spec committed, implementation not started. Main pieces: `iterate/sdk` export in
packages/iterate (generated types + hand-written helpers file), pkg.pr.new
continuous preview publishing via GitHub Actions, project-repo-template switched
from the committed `sdk.ts` snapshot to the published package, and the userland
Slack surface (`slack.config.ts`) removed from the template.

## Motivation

Customer project repos currently get the platform's itx types as a committed
snapshot: `apps/os/project-repo-template/sdk.ts` (a copy of
`apps/os/src/itx-api.generated.ts`, seeded via `PROJECT_REPO_INITIAL_FILES`).
That file is types-only, frozen at seed time, and there is nowhere to put
runtime helpers. Replace it with a real `iterate/sdk` package export — one
hand-written `sdk.ts` in `packages/iterate` we can keep adding helpers to,
re-exporting the generated contract.

`iterate@0.2.7` on npm has no `/sdk` export and npm publishing is a manual OTP
flow (`pubme.js`), so the template can't depend on a semver range yet. Instead:
continuous preview publishing with [pkg.pr.new](https://github.com/stackblitz-labs/pkg.pr.new),
and the template depends on `https://pkg.pr.new/iterate/iterate/iterate@main`
(branch refs resolve to the latest published commit on that branch).

## Decisions / assumptions (made while Misha was AFK-ish)

- **pkg.pr.new runs in real GitHub Actions** (`.github/workflows/pkg-pr-new.yml`),
  not Depot CI: pkg.pr.new's backend verifies publishes against the GitHub
  Actions API via its GitHub App, and Depot runs aren't GHA runs. Precedent for
  GHA-when-Depot-can't: `claude-assistant.yml`.
- **Manual step for Misha:** install the pkg.pr.new GitHub App on
  `iterate/iterate` (https://github.com/apps/pkg-pr-new). Publishes fail until
  then. No npm token needed — pkg.pr.new hosts the tarballs.
- **`iterate` goes in the template's `devDependencies`, not `dependencies`.**
  All template imports of the sdk are `import type` (erased at bundle), so the
  worker build pipeline never needs to install it; keeping it out of
  `dependencies` avoids betting new-project worker builds on
  `@cloudflare/worker-bundler` supporting https-URL specifiers. Agents/humans
  running `npm install` in the seeded repo still get real types. Revisit when
  the sdk grows runtime helpers (verify the bundler installs URL deps first).
- **The generator writes the package copy directly** — `generate-itx-api.ts`
  emits `packages/iterate/src/itx-api.generated.ts` alongside the apps/os one,
  guarded by a freshness test in apps/os (packages/iterate is excluded from
  root CI pipelines via `--filter '!iterate'`). We do NOT add another
  eslint-plugin-codegen `preset: copy` block: that preset silently failed to
  fire under the oxlint bridge before (see project-repo-template.test.ts).
- **Removing `slack.config.ts` removes the whole userland Slack surface from
  the template** (the `get slack()` getter, `@slack/web-api` dep, docs lines):
  a committed config of nulls was the dumb part, and the getter is useless
  without it. The platform-side Slack capability (slack-api.ts) is unaffected.
  The worker-build e2e test that exercised it is reworked to commit its own
  `package.json` + `worker.ts` — better coverage anyway (proves users can ADD
  deps, not just use seeded ones).

## Checklist

### packages/iterate

- [ ] `src/sdk.ts` — hand-written, `export type * from "./itx-api.generated.ts"`
      plus a home for future helpers
- [ ] `src/itx-api.generated.ts` — second emit target of
      `apps/os/scripts/generate-itx-api.ts`
- [ ] freshness guard in apps/os tests (copy matches `apps/os/src/itx-api.generated.ts`)
- [ ] `package.json`: `./sdk` in `exports` + `publishConfig.exports`; bump to 0.3.0
- [ ] `tsdown.config.ts`: add `src/sdk.ts` entry (esm + dts)
- [ ] repoint `src/cli.ts` type imports from `../../../apps/os/src/itx-api.generated.ts`
      to the local copy (the runtime `connectItx` import stays for now)

### pkg.pr.new

- [ ] `.github/workflows/pkg-pr-new.yml`: on push to main + pull_request;
      pnpm install (filtered), build packages/iterate, `pkg-pr-new publish ./packages/iterate`
- [ ] verify a publish succeeds once the GitHub App is installed (blocked on Misha)

### project-repo-template

- [ ] delete `sdk.ts`; imports in `worker.ts`, `apps/*/worker.ts` → `"iterate/sdk"`
- [ ] remove `"sdk.ts"` from the hello app's include globs in `worker.ts`
- [ ] delete `slack.config.ts`; remove `WebClient` import, `get slack()`,
      `@slack/web-api` dep
- [ ] `package.json`: `devDependencies.iterate = "https://pkg.pr.new/iterate/iterate/iterate@main"`
- [ ] update `AGENTS.md` (sdk.ts snapshot note → iterate/sdk; drop Slack config line),
      `README.md` seeded-file lists, `ONBOARDING.md` if it mentions either file
- [ ] regenerate `project-repo-template.generated.ts` (`pnpm lint --fix`)

### tests

- [ ] `project-repo-template.test.ts`: drop the `@slack/web-api` range test and
      the sdk.ts-verbatim test; add one asserting the template depends on the
      pkg.pr.new URL / has no sdk.ts
- [ ] `e2e/vitest/project-ingress.e2e.test.ts`: seeded file listing no longer
      contains `slack.config.ts` / `sdk.ts`
- [ ] `e2e/vitest/worker-build.e2e.test.ts`: rework the Slack test to commit its
      own `package.json` (+ `@slack/web-api`) and `worker.ts` (slack getter +
      invokeCapability + waitrose getter), keeping npm-install-at-build and
      userland-dispatch coverage
- [ ] `pnpm typecheck && pnpm lint && pnpm format && pnpm test` green

## Implementation log

(appended as work happens)
