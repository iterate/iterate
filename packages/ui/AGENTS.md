# packages/ui

The UI kit every client app imports as `@iterate-com/ui/*`.

## Vendored shadcn components

shadcn's styled components are copy-only by design: there is no styled package. So packages/ui
vendors them. Each of these files is byte for byte what the pinned shadcn CLI writes through
`components.json` (style `base-nova`, on Base UI), and nobody edits one here: alert-dialog, avatar,
badge, breadcrumb, button, card, checkbox, command, dialog, dropdown-menu, empty, field, input,
label, native-select, select, separator, sheet, sidebar, skeleton, sonner, spinner, table, tabs,
textarea and tooltip in `src/components/`, plus `src/components/input-group.tsx` (command's
dependency) and `src/hooks/use-mobile.ts` (sidebar's). `scripts/ci/shadcn-drift.ts` lists them.

- **Customise at the call site or in a wrapper** of our own, never in the file: a `className`, a
  prop, or a component here that renders the vendored one. The table below shows where each earlier
  local change went.
- **Keep the `dark:` classes.** Don't strip them. The apps are light mode only, and `globals.css`
  makes `dark:` never match (`@custom-variant dark (@media not all)`). The unused rules cost about
  1.6 KB of CSS.
- **`cn` comes from the `cn` package** (shadcn's replacement for clsx + tailwind-merge), which the
  CLI's files import directly. Our own files import it the same way: there is no `lib/utils`.
- **`globals.css` imports `shadcn/tailwind.css`**: the `data-*` variants these components are
  written against, `no-scrollbar`, `scroll-fade` and `shimmer`. It comes from the `shadcn`
  devDependency, pinned exactly, which is also the CLI.
- **Our tooling leaves them alone.** oxlint (the `iterate/*` and jsx-a11y rules included), oxfmt,
  knip's unused-export check and the `rules/` review rules all exclude them. Each of those lists
  names the files. `scripts/ci/shadcn-drift.test.ts` checks that the oxlint list, the oxfmt list
  and the drift check's path filter name all of them.

### Refresh

```sh
pnpm tsx scripts/ci/shadcn-drift.ts refresh  # shadcn add <every item> -o -y
git diff                                     # review what upstream changed
```

Review the diff instead of re-applying patches: there are none. Keep a dependency the CLI adds to
`package.json`, run `pnpm install`, then typecheck packages/ui and each app. To look at one file
first, without writing anything:

```sh
pnpm --dir packages/ui exec shadcn add button --dry-run --diff src/components/button.tsx
```

To bump the CLI, change the `shadcn` pin in `package.json` and refresh. To vendor another item, run
`pnpm --dir packages/ui exec shadcn add <item>`, then add it to `SHADCN_ITEMS` (and any new file to
`VENDORED_FILES`) and to the lists above.

### The drift check

- **On a pull request** that touches a vendored file, `components.json` or `package.json`,
  `.depot/workflows/shadcn-drift.yml` runs `shadcn-drift.ts check`. It asks the CLI's dry run what
  `add` would write, from shadcn's live registry, and fails on any file it would overwrite or
  create, printing the diff. The fix is a refresh, even when the difference is upstream moving
  rather than a hand edit. It is not a required check, and a pull request that leaves these files
  alone never runs it: it needs the network.
- **Daily**, `.depot/workflows/shadcn-upstream.yml` runs `shadcn-drift.ts report` on main and posts
  to Slack #ci when the set of files upstream has moved changes.

### Where the local changes went

| Was in                    | Now                                                                                                       |
| ------------------------- | --------------------------------------------------------------------------------------------------------- |
| button: hover title       | Each icon-size `Button` passes `title`; `iterate/icon-button-has-hover-text` requires it at the call site |
| sheet: full width (#1883) | The `SheetContent` call site passes `data-[side=right]:w-full`                                            |
| sidebar: close (#1984)    | `SidebarNav` in `app-shell.tsx`: a same-tab link click closes the phone's sheet (shadcn-ui/ui#5561)       |
| command: ⌘K look (#2991)  | `app-shell-palette.tsx`: the classNames it passes, and its own search row over cmdk's input               |
| sonner: light only        | `AppProviders` renders `<Toaster theme="light" />`; `toast` is imported from `sonner`                     |
| dialog, sheet: close      | Upstream's: an sr-only "Close"                                                                            |
| breadcrumb, label         | Upstream's                                                                                                |

## AI Elements

`components/ai-elements/` is a fork of Vercel's AI Elements, refreshed by hand. It is copy-only
too, and Radix-only: the Base UI variant, vercel/ai-elements#450, is still open. So it is our code,
not vendored in the sense above.

Everything else here is our own code.
