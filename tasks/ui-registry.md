---
status: in-progress
size: large
---

# packages/ui is a shadcn registry, served from iterate/packages

UI PR 2 (UI PR 1 was `tasks/complete/2026-09-30-os-owns-ui.md`). An app in another repo gets one of
our rendered components with `shadcn add @iterate/<item>` and keeps its own copy. Apps in this
repo keep importing `@iterate-com/ui`.

Status: implemented, waiting on CI and review.

- Done: packages/ui laid out like an app (vendored shadcn in `components/ui/`, `#/` imports between
  items), 18 items in `registry.json`, `r/` built and committed, the build and its checks, and docs.
- Left: CI on the PR.

## Context

- 09/29 and 10/01 Tuple calls: hooks and providers live in the `iterate` package (`iterate/react`);
  rendered components ship as a shadcn registry and each app keeps its own copy ("the other apps
  will all have their own copy of a button and so on, but that doesn't bother me one bit"). On
  10/01 they agreed that iterate/packages, the public one-way copy of `packages/`, is the registry.
- #3493: Copybara copies `packages/**` to github.com/iterate/packages after each Deploy OS run, and
  `packages/ui/**` is in Deploy OS's path filter. So a change to the registry is public after the
  next deploy, at the same path.
- shadcn's vendored components stay upstream's. Our items name them in `registryDependencies`
  (`button`) instead of serving copies of them.
- Superseded: an earlier draft published the registry through pkg.pr.new, because iterate/iterate
  is going private.

## Shape

```jsonc
// an app's components.json
{
  "style": "base-nova",
  "aliases": {
    "components": "#/components",
    "ui": "#/components/ui",
    "hooks": "#/hooks",
    "lib": "#/lib",
    "utils": "cn",
  },
  "registries": {
    "@iterate": "https://raw.githubusercontent.com/iterate/packages/main/packages/ui/r/{name}.json",
  },
}
```

```sh
pnpm dlx shadcn@4.21.0 add @iterate/context-view   # writes src/components/context-view/*, plus button, sheet, … from shadcn
```

- `packages/ui/registry.json` lists the items. `shadcn build -o r` writes `packages/ui/r/<item>.json`,
  which is committed. CI fails when `r/` is out of date.
- **packages/ui is laid out like an app after `shadcn add`**, so `shadcn build` takes its files
  unchanged:
  - shadcn's vendored components move to `src/components/ui/`. That is shadcn's convention and
    core/os's, and the folder the CLI writes `registryDependencies` into. Ours stay in
    `src/components/`.
  - Imports use `#/*` subpath imports (`"imports": { "#/*": "./src/*" }`, as in core/os), with
    extensions. `shadcn add` rewrites `#/components/ui/button.tsx` to the consumer's aliases: an
    app with `@/` aliases gets `@/components/ui/button`, and one with `#/` aliases gets the same
    text back. Checked against the pinned CLI.
  - An import of another item's file uses `#/`. Files in the same item import each other
    relatively (`./filters.tsx`), so an item in a folder keeps its folder.
- Apps in the monorepo keep importing `@iterate-com/ui/*` through the workspace (decided in review:
  shadcn's own monorepo setup shares one `packages/ui` workspace, and a registry is for other
  repos). The only
  change for them is the vendored components' new path (`@iterate-com/ui/components/ui/button`).

### Items

One item per rendered component, named after its file or folder. A file belongs to exactly one
item.

| Item                       | Files                                          | Our items it needs                        |
| -------------------------- | ---------------------------------------------- | ----------------------------------------- |
| `app-shell`                | app-shell, app-shell-palette, -palette-entries | iterate-logo, posthog, plain-left-click   |
| `project-app-shell`        | project-app-shell                              | app-shell                                 |
| `app-build`                | app-build                                      |                                           |
| `code-block`               | code-block, code-block.client                  |                                           |
| `code-editor`              | code-editor, code-editor.client                |                                           |
| `connect-button`           | connect-button                                 |                                           |
| `context-view`             | `context-view/*`                               | code-block, code-editor, plain-left-click |
| `environment-head-content` | environment-head-content                       |                                           |
| `first-project-redirect`   | first-project-redirect                         | route-defaults                            |
| `iterate-logo`             | iterate-logo (+ the svg)                       |                                           |
| `log-in-with-iterate`      | log-in-with-iterate                            | iterate-logo                              |
| `not-recorded`             | not-recorded                                   |                                           |
| `posthog`                  | posthog                                        |                                           |
| `repo-ide`                 | `repo-ide/*`                                   |                                           |
| `route-defaults`           | route-defaults                                 | posthog                                   |
| `standalone-page`          | standalone-page                                |                                           |
| `stream-link`              | stream-link                                    |                                           |
| `plain-left-click`         | `lib/plain-left-click.ts` (`registry:lib`)     |                                           |

The table is the intent; `registry.json` is the source of truth.

Not in the registry:

- `src/apps/*` (the Worker entry, router, document and head every TanStack Start app shares). It
  is app framework rather than a component, and it imports the private `@iterate-com/shared`.
- `hooks/use-context-explorer.ts`: a hook, so it belongs in `iterate/react`.
- shadcn's vendored components and `globals.css`.

### Checks

- Lint and Typecheck: `shadcn build` leaves `packages/ui/r/` unchanged (offline, fast).
- ~~`packages/ui/src/registry.test.ts` checks each item's imports against registry.json~~ _(tests
  don't read source text (docs/vitest-patterns.md rule 8), and when two files must agree one is the
  source of the other. So `scripts/ci/shadcn-registry.ts build` derives each item's dependencies
  from its imports, and throws on the same boundary problems. Its pure functions have unit tests.)_
- The shadcn workflow (network, path filtered, not required; today's drift check): adding every
  `@iterate` item to a copy of packages/ui's config, from the freshly built registry served
  locally, writes back packages/ui's exact bytes. This proves the CLI rewrites and places files the
  way the item test assumes.

## Assumptions (made while Misha was away; easy to change)

- The `@iterate` namespace and `iterate` registry name: the user's phrasing, and free in
  shadcn's public index.
- `posthog` is a registry item rather than part of `iterate/react`, because that would give core a
  `posthog-js` dependency. `app-shell` and `route-defaults` need it.
- `plainLeftClick` moves out of `app-shell-palette-entries.ts` into a `plain-left-click` lib item,
  because both `app-shell` and `context-view` use it. The alternative was to make `context-view`
  depend on the whole app shell.
- `dependencies` name packages without versions, as shadcn's own items do. An app that already has
  a package keeps its version (the CLI skips installed ones), so `iterate` stays the app's
  pkg.pr.new pin.
- Items name shadcn's items by bare name (`button`), which assumes the consumer uses a Base UI style
  (`base-nova`).
- No theme item yet: `globals.css`'s tokens are base-nova/neutral's plus a few of ours.

## Checklist

- [x] Vendored components into `src/components/ui/` via the drift script's refresh, with the lint,
      format, `rules/` and workflow lists following _(refresh rewrote them through the new `#/` aliases; pure renames apart from their import lines)_
- [x] `#/*` imports in packages/ui. Cross-item imports use `#/`, and same-item imports stay relative _(a one-off codemod; `build` now enforces it)_
- [x] Apps' imports of vendored components follow the move _(`@iterate-com/ui/components/ui/<name>`, 38 files)_
- [x] `plainLeftClick` into `src/lib/plain-left-click.ts` _(also the logo's svg beside `iterate-logo.tsx`)_
- [x] `registry.json`, the build script, and the committed `r/` _(`node scripts/ci/shadcn-registry.ts build`, in scripts/ci beside the drift script: scripts already depends on oxc-parser, so the lockfile stays out of this PR)_
- [x] ~~Registry item test~~ _(the boundary checks live in `build` instead; see Checks)_
- [x] Lint and Typecheck step: `registry.json` and `r/` up to date
- [x] Round-trip check in the shadcn workflow _(`shadcn-registry.ts round-trip`)_
- [x] `packages/ui/AGENTS.md`: adding an item, and how an app installs one. Also the iterate/packages
      README (`copybara/packages/README.md`)
- [x] Typecheck, lint, format, knip, tests; build one app to prove `#/` resolves across packages _(all seven apps typecheck; notes builds with Vite)_

## Out of scope (follow-ups)

- `use-context-explorer` into `iterate/react`, and the app shell (`src/apps/*`) into `iterate`.
- A theme item for `globals.css`'s tokens.

## Implementation notes

- The CLI returns ts-morph's `sourceFile.getText()`, which starts at the first statement. So an
  installed file loses its leading comment, including the JSDoc on its first export when it has no
  imports. Upstream: shadcn-ui/ui#9206, open fix shadcn-ui/ui#11920. The round trip allows exactly
  that loss.
- Which `"use client"` lines shadcn's own items get depends on the batch `add` processes (also in
  os-owns-ui's notes). So the round trip leaves shadcn's items to the drift check.
- The round trip's local server runs in the same process as the CLI call, so that call has to be
  async: `spawnSync` deadlocked it.
- Adding `oxc-parser` to packages/ui made pnpm re-resolve crossws's optional `srvx` peer across the
  lockfile (#3494 flipped it the other way). Hosting the script in `scripts/ci`, which already
  depends on oxc-parser, avoided that churn.
- TypeScript 7 has no JS API (`ts.preProcessFile` is gone), hence oxc-parser for imports.
- One-off end-to-end proof (not in CI): a fresh app with `@/` aliases and base-nova installed all
  18 items (`shadcn add`, 81 files), and `tsc` passed. The installed files import
  `@/components/ui/button` and `@/components/code-block`. It needed what `shadcn init` installs
  (base-nova's items list only `cn`; the style brings `@base-ui/react` and the rest), lib
  `ESNext.Disposable` (repo-ide's `using`), and a fresh `iterate`: the local pnpm store served a
  stale 0.3.0 for `pkg.pr.new/...iterate@main`, whose live tarball is 0.4.1.
