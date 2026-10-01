---
status: in-progress
size: large
---

# The public `iterate/core` and `iterate/packages`: one-way copies

The payoff of the core pre-work. `core/` builds from a clone of itself (#3486, #3487, #3489,
#3492), so it can be copied to a public `iterate/core` after every production deploy, with
Copybara, as the experiment (#3434, iterate/os0929) proved; `packages/` and the project templates
in `configs/` go to a public `iterate/packages` the same way. Nothing flows back.

Status: implemented; waiting on CI, then the first copies after merge. iterate/core (renamed from
the iterate/os made earlier the same day) and iterate/packages exist, public and empty; core's check
passes locally; the App mints a write token for both. Left: merge, and the first deploy's copy job
seeding them.

## Decisions

The approach is the experiment's (tasks/copybara0929-experiment.md on its branch); these are the
differences for the real thing, my calls where Misha didn't say:

- **Two copies, named after their folders** (Misha and Jonas's standup, 2026-10-01): `iterate/core`
  holds `core/`, `iterate/packages` holds `packages/` and `configs/`. Neither is flattened, so a
  path means the same file in both. The packages stay on pkg.pr.new. The iterate App is installed on
  every repository in the org, so it can push to both.
- **Configs go in iterate/packages:** today's templates depend on packages outside core (agents,
  voice). Dependency-free starter configs move into core later. The self-host recipe bakes
  iterate's templates with `--template "github:iterate/packages#main&path:configs/<name>"`: the
  build pins `main` to a commit, so it survives iterate/iterate going private, with no lookup of the
  copy's origin commit.
- **What iterate/core holds:** `core/**`, and the root files `core/` needs to install and build: `LICENSE`,
  `tsconfig.base.json`, `tsconfig.app.json`, `.nvmrc`, `patches/**`, plus the copy's own root files
  in `copybara/core/` (README, `package.json`, `.gitignore`, and a `pnpm-workspace.yaml` and
  `pnpm-lock.yaml` generated from this repo's for `core/os` and `core/lib` alone). Paths stay as
  they are here (`core/os/…`), so a path means the same file in both repos.
- **When:** Deploy OS, after the production deploy and its host check: copy both up to the deployed
  commit, check each (its tree equals what Copybara would write), and run the self-host recipe
  against a fresh clone of iterate/core (install, build, dry-run deploy). iterate/packages is source
  to read: it isn't installed or built.
- **Pull requests copy nothing.** A PR's preview runs the copy into a folder and the recipe
  against it, so a PR that would break the copy's build is red before it merges, and only main's
  deployed commits reach the public repo.
- **History starts at the first deploy after this merges:** an empty copy is seeded with
  `--force --last-rev <that commit's parent>`, one snapshot, not ~800 old commits.
- **Messages:** the PR title with `(iterate/iterate#N)`, and only the paragraphs a PR body wraps
  in `<!-- copybara -->` … `<!-- /copybara -->`, then Copybara's `GitOrigin-RevId` trailer.
- **The self-host recipe clones iterate/core.**
- **The experiment stays as it is** (#3434, os0929, packages0929) until this one has run on main;
  closing and deleting them is Misha's call.

## Checklist

- [x] `copybara/copy.bara.sky`: the `core` and `packages` workflows, the files above
- [x] `copybara/core/`: README, package.json, .gitignore, the generated workspace and lockfile;
      `copybara/packages/`: README
- [x] `scripts/ci/copybara.ts`: sync, seed an empty copy, the sync check, the recipe check, the
      root generator, and a `--to-folder` run for pull requests _(`check`)_
- [x] `scripts/ci/iterate-app-token.ts` shared with the flake dashboard
- [x] Deploy OS's copy job; Preview OS's folder-only check when the copy's inputs change _(its own workflow, `.depot/workflows/copybara.yml`, path-filtered, off the required checks)_
- [x] create `iterate/core` and `iterate/packages` (public, empty) _(2026-10-01; iterate/os renamed)_
- [x] the self-host recipe clones iterate/core and bakes templates from iterate/packages#main
- [ ] typecheck, lint, knip, format, tests; CI green; after merge, the first copy and its checks

## Out of scope

- Making iterate/iterate private (a public archive, with work moving to iterate/private), the
  shadcn registry on iterate/packages, dependency-free configs in core, agents and voice out of the
  default config: the standup's other items.
- Taking contributions back from the copy.

## Implementation notes

- The root generator broke twice on today's main, both now handled: pnpm's first pass rewrites
  the scratch workspace with single-quoted keys (the patch filter matched double quotes only), and
  `cleanupUnusedCatalogs` drops `@codemirror/state` from the copy's catalog while an override still
  names it (core/os stopped using packages/ui in #3486). The workspace is now edited as a YAML
  document: patches and overrides of packages the copy doesn't resolve are dropped.
- Not done, Misha's call: rulesets on both copies that refuse pushes from anyone but the App, so
  nobody edits the copy by hand (the sync check catches it, and the next copy overwrites it).
