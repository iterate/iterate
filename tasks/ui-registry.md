---
status: in-progress
size: large
---

# packages/ui is a shadcn registry, served from iterate/packages

UI PR 2 (UI PR 1 was `tasks/complete/2026-09-30-os-owns-ui.md`). An app gets one of our rendered
components with `shadcn add @iterate/<item>` and keeps its own copy.

Status: spec only. Nothing implemented yet.

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
- **packages/ui is laid out like an app after `shadcn add`**, so `shadcn build` serves its files
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
- Apps in the monorepo keep importing `@iterate-com/ui/*` through the workspace for now. The only
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

The table is the intent; `registry.json` and its test are the source of truth.

Not served:

- `src/apps/*` (the Worker entry, router, document and head every TanStack Start app shares). It
  is app framework rather than a component, and it imports the private `@iterate-com/shared`.
- `hooks/use-context-explorer.ts`: a hook, so it belongs in `iterate/react`.
- shadcn's vendored components and `globals.css`.

### Checks

- Lint and Typecheck: `shadcn build` leaves `packages/ui/r/` unchanged (offline, fast).
- `packages/ui/src/registry.test.ts` (offline, pure) checks every item:
  - each relative import is a file in the same item;
  - each `#/` import is a file of an item it depends on, transitively, ours or shadcn's;
  - each package import is in its `dependencies`;
  - every non-test file in `src/components` outside `ui/` belongs to exactly one item, or is on the
    not-served list.
    So a fresh app gets every file an item imports.
- The shadcn workflow (network, path filtered, not required; today's drift check): adding every
  `@iterate` item to a copy of packages/ui's config, from the freshly built registry served
  locally, writes back packages/ui's exact bytes. This proves the CLI rewrites and places files the
  way the item test assumes.

## Assumptions (made while Misha was away; easy to change)

- The `@iterate` namespace and `iterate` registry name: the user's phrasing, and free in
  shadcn's public index.
- `posthog` is a served item rather than part of `iterate/react`, because that would give core a
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

- [ ] Vendored components into `src/components/ui/` via the drift script's refresh, with the lint,
      format, `rules/` and workflow lists following
- [ ] `#/*` imports in packages/ui. Cross-item imports use `#/`, and same-item imports stay relative
- [ ] Apps' imports of vendored components follow the move
- [ ] `plainLeftClick` into `src/lib/plain-left-click.ts`
- [ ] `registry.json`, the `registry:build` script, and the committed `r/`
- [ ] Registry item test
- [ ] Lint and Typecheck step: `r/` up to date
- [ ] Round-trip check in the shadcn workflow
- [ ] `packages/ui/AGENTS.md`: adding an item, and how an app installs one. Also the iterate/packages
      README (`copybara/packages/README.md`)
- [ ] Typecheck, lint, format, knip, tests; build one app to prove `#/` resolves across packages

## Out of scope (follow-ups)

- Moving the monorepo apps from `@iterate-com/ui` imports to their own copies.
- `use-context-explorer` into `iterate/react`, and the app shell (`src/apps/*`) into `iterate`.
- A theme item for `globals.css`'s tokens.
