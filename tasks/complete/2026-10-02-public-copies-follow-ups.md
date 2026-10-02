---
size: medium
---

# The public copies: locked down, licensed, and documented for outsiders

iterate/core and iterate/packages are public one-way Copybara copies of this repo (iterate/iterate#3493:
`copybara/copy.bara.sky`, `scripts/ci/copybara.ts`, the copybara job in
`.depot/workflows/deploy-os.yml`). iterate/iterate is about to become a public archive, with work
moving to a private iterate/private (iterate/iterate#3506, iterate/iterate#3507), so these two become the only public copy of
the code. Three follow-ups from iterate/iterate#3493.

## Status

- Done in iterate/iterate#3508. Rulesets and secret scanning are live on both copies; licenses,
  docs and the dead-link test are in the PR.
- One check after the next Deploy OS copy: the App still pushes past the rulesets.

## 1. Only the iterate App writes the copies

Both copies had no rulesets, no branch protection, and secret scanning and push protection off.
Copybara's `destination_files = **` wipes a hand edit on the next copy and `checkCopy` goes red on
a drifted head, but nothing stops the edit landing first.

- [x] A branch ruleset on each copy, `~ALL` branches: creation, update, deletion and
      non-fast-forward restricted; the only bypass actor is the iterate App (`Integration`
      2001598, the `iterate[bot]` that pushes the copies today). No bypass for org admins: they can
      still edit the ruleset, deliberately. _"Only the iterate App writes branches": core 24319445,
      packages 24319453._
- [x] The same for tags (creation, update, deletion). _"…writes tags": core 24319447, packages 24319455._
- [x] Secret scanning, push protection, non-provider patterns and validity checks on, as on
      iterate/iterate. _`gh api -X PATCH repos/iterate/<copy>` `security_and_analysis`._
- [ ] Prove a non-App push is refused. Prove the App still pushes on the next Deploy OS copy
      (`gh api repos/iterate/core/rulesets/rule-suites` shows its bypass). _First half done: an
      org admin's push to iterate/core was declined ("creations being restricted"). Second half
      waits for a deploy._
- [x] `scripts/ci/copybara.ts`'s header says the rulesets exist.

GitHub settings, applied with `gh api`; nothing in the repo applies them.

## 2. Licenses say what they mean

The root `LICENSE` and package.json are AGPL-3.0 (kept: Misha and Jonas, 2026-10-01). Copybara
copies `LICENSE` into both copies. But `core/lib` (npm `iterate`, the SDK users' config workers
bundle) and `packages/{ai-linter,docs,github-sync,petshop-sdk,voice}` say `Apache-2.0` with no
license file, so pnpm packs the root AGPL text into them: the published `iterate@0.4.0` says
Apache-2.0 in package.json and ships the AGPL text.

Decided (Misha, 2026-10-01):

- [x] The SDK and the installable packages are Apache-2.0: an Apache-2.0 `LICENSE` in `core/lib`
      and each of those packages, so their tarballs ship it. _apache.org's LICENSE-2.0.txt
      verbatim; `pnpm pack` of petshop-sdk ships it._
- [x] `packages/ui`, the shadcn registry whose components people copy into their own apps, is
      Apache-2.0 too (LICENSE, and `license` in its package.json).
- [x] The project templates are Apache-2.0: one `LICENSE` beside them, `core/configs/LICENSE` and
      `configs/LICENSE`. Not in each template folder, and no `license` in a template's
      package.json: a template folder is copied whole into every project born from it, which would
      label the user's own project. _Both template listings take folders only (core/os/scripts/build.ts,
      scripts/os/config-templates.ts), so the files are never offered as templates._
- [x] core/os and everything else stays AGPL-3.0. _packages/shared included._
- [x] Each copy's README says which parts are which. _copybara/{core,packages}/README.md._

## 3. iterate/core's docs are written for iterate/core

`core/os/README.md` is public in iterate/core but documents iterate-internal operations (Doppler
`os/preview`, `depot ci dispatch --repo iterate/iterate`, `envs.ts`, `*.iterate-dev-preview.workers.dev`,
`scripts/os/*`) and links `docs/`, `test/` and `packages/ui`, which iterate/core doesn't hold.

- [x] core/os/README.md keeps what the platform is and how to develop it; iterate's operations
      move to where iterate's tooling is documented:
  - preview commands and facts → `docs/dev-environments.md`, and the docs that pointed at the
    README for them point there;
  - production's hand-made setup (identity-provider callbacks, email domains, DNS) → a comment
    on `osEnvs.prd` in `envs.ts`;
  - the D1 names and `seed-instance-secrets` → `docs/dev-environments.md`.
- [x] `core/os/docs/project-seeds.md` (the prd recovery runbook, with @nustom.com emails) moves to
      `docs/project-seeds.md`; the `recreate-production` skill follows it.
- [x] Dead links fixed in `core/os/docs/{residency,credentials}.md` and
      `core/os/src/context/AGENTS.md`; the context AGENTS.md drops the slow-row instruction the
      root AGENTS.md already gives.
- [x] The same class of dead link in iterate/packages (`configs/README.md`,
      `packages/{docs,petshop-sdk}/README.md`).
- [x] `core/os/wrangler.base.jsonc:5` no longer describes the envs.ts lookup iterate/iterate#3448 removed.
- [x] A test fails when a markdown file in either copy links a file the copy doesn't hold
      (`lint/copy-doc-links.test.ts`). _Fails on the old README with its 9 dead links. The AI
      linter's rule fixtures are skipped: they are rule files copied verbatim._

## Implementation notes

- The README told people to run `pnpm preview` from `core/os`, which has no such script since
  iterate/iterate#3456 moved the tooling to `scripts/os`; `docs/dev-environments.md` now says the repository
  root.
- iterate/iterate#3507 landed mid-task and rewrote `scripts/ci/copybara.ts`'s header and the README's MCP
  sentence (now `examples/mcp-run-scripts.mjs`, which iterate/core holds). Kept main's text in
  both; the ruleset sentence joins the new header. iterate/iterate#3507 also covers the Copybara origin and token
  for iterate/private, which this task had flagged.
- `packages/ui`'s app server (`src/apps/server.ts`) imports `@iterate-com/shared`, which stays
  AGPL. No registry component imports it (`posthog.tsx` only names it in a comment).
