---
status: in-review
size: medium
branch: publish-iterate-sdk
pr: https://github.com/iterate/iterate/pull/1758
---

# Publish `iterate` with an `iterate/sdk` export; template consumes it via pkg.pr.new

## Status summary

Implementation complete, PR open, preview publish verified live. The
pkg.pr.new GitHub App turned out to already be installed on `iterate/iterate`:
the PR's publish run succeeded, and a simulated customer repo installed
`https://pkg.pr.new/iterate/iterate/iterate@1758` and typechecked against it.
Remaining: e2e lanes in CI; the template's `@main` URL goes live with the
first push-to-main publish (i.e. when this PR merges).

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
  GHA-when-Depot-can't: `claude-assistant.yml`. Runner: `depot-ubuntu-24.04`
  (Depot-managed GHA runner, same as claude-assistant).
- ~~**Manual step for Misha:** install the pkg.pr.new GitHub App~~ _(already
  installed — the PR's publish run succeeded first try. No npm token needed;
  pkg.pr.new hosts the tarballs.)_
- **`iterate` goes in the template's `devDependencies`, not `dependencies`.**
  Verified in `@cloudflare/worker-bundler`'s installer source: it only installs
  `dependencies` (devDependencies require an off-by-default `dev` option), and
  it resolves ONLY registry semver ranges — an https tarball URL in
  `dependencies` would break every project worker build. All template imports
  of the sdk are `import type` (erased at bundle), so the bundler never needs
  it; `npm install` in the seeded repo (agents/humans) understands the URL and
  gets real types. Revisit when the sdk grows runtime helpers.
- **The generator writes the package copy directly** — `generate-itx-api.ts`
  emits `packages/iterate/src/itx-api.generated.ts` alongside the apps/os one,
  guarded by a freshness test in apps/os (packages/iterate is excluded from
  root CI pipelines via `--filter '!iterate'`). We do NOT add another
  eslint-plugin-codegen `preset: copy` block: that preset silently failed to
  fire under the oxlint bridge before (see project-repo-template.test.ts).
- **sdk declarations are emitted with plain tsc** (`tsconfig.sdk.json`,
  `emitDeclarationOnly`): tsdown's dts pipeline (rolldown-plugin-dts →
  @babel/generator 8 rc) crashes on the generated contract's getter
  signatures. `src/sdk.ts` uses an extensionless re-export specifier because
  it lands verbatim in the published `dist/sdk.d.ts`.
- **pkg-pr-new publishes with `--pnpm`**: `npm pack` does not apply
  `publishConfig.exports`, so the tarball would ship dev exports pointing at
  `src/`. `pnpm pack` applies the dist remap (this is also how the existing
  `pubme.js` flow produced correct tarballs).
- **Removing `slack.config.ts` removes the whole userland Slack surface from
  the template** (the `get slack()` getter, `@slack/web-api` dep, docs lines):
  a committed config of nulls was the dumb part, and the getter is useless
  without it. The platform-side Slack capability (slack-api.ts) is unaffected.
  The worker-build e2e test was reworked to commit its own `package.json` +
  `worker.ts` — better coverage anyway (proves users can ADD deps, not just
  use seeded ones), plus a separate seeded-worker cold-build test keeping the
  waitrose dispatch coverage.

## Checklist

### packages/iterate

- [x] `src/sdk.ts` — hand-written, re-exports the generated contract, home for
      future helpers _(type-only re-export for now; extensionless specifier on purpose)_
- [x] `src/itx-api.generated.ts` — second emit target of
      `apps/os/scripts/generate-itx-api.ts` _(replaces the `sdkCopyPath` walker exclusion)_
- [x] freshness guard _(new test in apps/os/src/itx-api.generated.test.ts)_
- [x] `package.json`: `./sdk` in `exports` + `publishConfig.exports`; bump to 0.3.0
- [x] `tsdown.config.ts`: sdk entry _(dts off; declarations via `tsc -p tsconfig.sdk.json` in build script)_
- [x] repoint `src/cli.ts` type imports to the local copy _(runtime `connectItx` import into apps/os stays)_
- [x] fix pre-existing type errors in `stream-tui/agent-chat-terminal.tsx`
      _(TUI had drifted from @iterate-com/ui's AgentUiItem union; blocked the build)_

### pkg.pr.new

- [x] `.github/workflows/pkg-pr-new.yml` _(push to main + pull_request; `pkg-pr-new publish --pnpm`)_
- [x] verify a publish succeeds _(PR run 28949722539 published; fake customer repo
      installed `…iterate@1758` from pkg.pr.new and typechecked)_

### project-repo-template

- [x] delete `sdk.ts`; imports → `"iterate/sdk"` _(worker.ts, apps/hello; counter/websocket had no sdk import)_
- [x] remove `"sdk.ts"` from the hello app's include globs
- [x] delete `slack.config.ts`, `WebClient` import, `get slack()`, `@slack/web-api` dep
- [x] `package.json`: `devDependencies.iterate = "https://pkg.pr.new/iterate/iterate/iterate@main"`
- [x] update `AGENTS.md`, apps/os `src/README.md` _(template README/ONBOARDING had no references)_
- [x] regenerate `project-repo-template.generated.ts`

### tests

- [x] `project-repo-template.test.ts`: replaced slack-range + sdk-verbatim tests
      with an iterate/sdk-consumption test
- [x] `project-ingress.e2e.test.ts`: file listing without sdk.ts/slack.config.ts
- [x] `worker-build.e2e.test.ts`: reworked _(seeded-worker waitrose test + add-npm-dep slack test)_
- [x] `live-capability-websocket.e2e.test.ts` _(imported "../../sdk.ts" in its committed app source)_
- [x] `pnpm typecheck && pnpm lint && pnpm format` green; unit tests green
- [x] simulated customer repo: template + `pnpm pack` tarball + `npm install` + `tsc` passes

## Implementation log

- Generator now writes both copies; deleting the template sdk.ts was a
  prerequisite (its exports collided with the walker's declaration scan —
  "ambiguous type ItxBinding").
- packages/iterate typecheck+build were already broken on main (it's excluded
  from root CI): stale TUI types + dts printer crash. Fixed the TUI type
  errors and routed sdk dts through plain tsc. `tsgo --noEmit` for the package
  still reports pre-existing errors in apps/os files pulled in via the
  `connectItx` runtime import (`~/...` alias resolution) — untouched, existing
  problem, tracked nowhere yet.
- Pre-existing test failure (also on main, not CI-visible):
  `packages/iterate/src/stream-tui/agent-feed-model.test.ts` "folds a chat
  round…" — the feed model drifted from the upstream reducer. Left alone;
  candidate follow-up task.
- Verified end-to-end: copied the template to a scratch dir, installed the
  `pnpm pack` tarball as the `iterate` devDependency, ran the template's own
  tsconfig — typecheck passes against `dist/sdk.d.ts`.
