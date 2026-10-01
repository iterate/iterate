---
status: in-progress
size: large
---

# The public `iterate/os`: a one-way copy of `core/`

The payoff of the core pre-work. `core/` builds from a clone of itself (#3486, #3487, #3489,
#3492), so it can be copied to a public `iterate/os` after every production deploy, with Copybara,
as the experiment (#3434, iterate/os0929) proved. Nothing flows back.

Status: implemented; waiting on CI, then the first copy after merge. iterate/os exists (public,
empty); the copy's check passes locally (Copybara's folder at this PR's head installs from its own
lockfile, builds, dry-run deploys, stays clean); the App mints a write token for it. Left: merge,
and the first deploy's copy job seeding it.

## Decisions

The approach is the experiment's (tasks/copybara0929-experiment.md on its branch); these are the
differences for the real thing, my calls where Misha didn't say:

- **One copy, `iterate/os`, a new public repo.** No `iterate/packages`: the packages stay on
  pkg.pr.new (option 1, 2026-10-01). The iterate App is installed on every repository in the org,
  so it can push there.
- **What it holds:** `core/**`, and the root files `core/` needs to install and build: `LICENSE`,
  `tsconfig.base.json`, `tsconfig.app.json`, `.nvmrc`, `patches/**`, plus the copy's own root files
  in `copybara/os/` (README, `package.json`, `.gitignore`, and a `pnpm-workspace.yaml` and
  `pnpm-lock.yaml` generated from this repo's for `core/os` and `core/lib` alone). Paths stay as
  they are here (`core/os/…`), so a path means the same file in both repos.
- **When:** Deploy OS, after the production deploy and its host check: copy up to the deployed
  commit, then check the copy (its tree equals what Copybara would write) and run the self-host
  recipe against a fresh clone (install, build, dry-run deploy).
- **Pull requests copy nothing.** A PR's preview runs the copy into a folder and the recipe
  against it, so a PR that would break the copy's build is red before it merges, and only main's
  deployed commits reach the public repo.
- **History starts at the first deploy after this merges:** an empty copy is seeded with
  `--force --last-rev <that commit's parent>`, one snapshot, not ~800 old commits.
- **Messages:** the PR title with `(iterate/iterate#N)`, and only the paragraphs a PR body wraps
  in `<!-- copybara -->` … `<!-- /copybara -->`, then Copybara's `GitOrigin-RevId` trailer.
- **The self-host recipe clones iterate/os**, and names iterate's templates at the copy's
  `GitOrigin-RevId` (the monorepo commit the copy came from).
- **The experiment stays as it is** (#3434, os0929, packages0929) until this one has run on main;
  closing and deleting them is Misha's call.

## Checklist

- [x] `copybara/copy.bara.sky`: the `os` workflow to iterate/os, the files above
- [x] `copybara/os/`: README, package.json, .gitignore, the generated workspace and lockfile
- [x] `scripts/ci/copybara.ts`: sync, seed an empty copy, the sync check, the recipe check, the
      root generator, and a `--to-folder` run for pull requests _(`check`)_
- [x] `scripts/ci/iterate-app-token.ts` shared with the flake dashboard
- [x] Deploy OS's copy job; Preview OS's folder-only check when the copy's inputs change _(its own workflow, `.depot/workflows/copybara.yml`, path-filtered, off the required checks)_
- [x] create `iterate/os` (public, empty) _(2026-10-01)_
- [x] the self-host recipe clones iterate/os
- [ ] typecheck, lint, knip, format, tests; CI green; after merge, the first copy and its checks

## Out of scope

- `iterate/packages`; making iterate/iterate private.
- Taking contributions back from the copy.

## Implementation notes

- The root generator broke twice on today's main, both now handled: pnpm's first pass rewrites
  the scratch workspace with single-quoted keys (the patch filter matched double quotes only), and
  `cleanupUnusedCatalogs` drops `@codemirror/state` from the copy's catalog while an override still
  names it (core/os stopped using packages/ui in #3486). The workspace is now edited as a YAML
  document: patches and overrides of packages the copy doesn't resolve are dropped.
- Not done, Misha's call: a ruleset on iterate/os that refuses pushes from anyone but the App, so
  nobody edits the copy by hand (the sync check catches it, and the next copy overwrites it).
