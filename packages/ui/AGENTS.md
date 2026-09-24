# packages/ui

The UI kit every client app imports as `@iterate-com/ui/*`.

## Vendored shadcn components

shadcn's styled components are copy-only by design: there is no styled package. So packages/ui
vendors them. Each of these files is byte for byte what the pinned shadcn CLI writes through
`components.json` (style `base-nova`, on Base UI), and nobody edits one here: alert-dialog, avatar,
badge, breadcrumb, button, card, checkbox, command, dialog, dropdown-menu, empty, field, input,
label, native-select, select, separator, sheet, sidebar, skeleton, sonner, spinner, table, tabs,
textarea and tooltip in `src/components/`, plus `src/components/input-group.tsx` (command's
dependency), `src/hooks/use-mobile.ts` (sidebar's) and `src/lib/utils.ts` (the `utils` item).
`scripts/ci/shadcn-drift.ts` lists them.

- **Customise at the call site or in a wrapper** of our own, never in the file: a `className`, a
  prop, or a component here that renders the vendored one. The table below shows where each earlier
  local change went.
- **Keep the `dark:` classes.** Don't strip them. The apps are light mode only, and `globals.css`
  makes `dark:` never match (`@custom-variant dark (@media not all)`). Dev CSS keeps those rules
  inside `@media not all`; the production build drops the block, so they ship no bytes.
- **`cn` comes from the `cn` package** (shadcn's replacement for clsx + tailwind-merge), which the
  CLI's components import directly. Our own files import it the same way. `src/lib/utils.ts` is
  shadcn's `utils` item, `export { cn } from "cn"`, and exists for the CLI: `components.json`'s
  `aliases.utils` names it, and the CLI rewrites a registry item's `@/lib/utils` import to it, as
  the AI Elements items still do. It is the one re-export docs/jonasland-rules.md allows.
- **`globals.css` imports `shadcn/tailwind.css`**: the `data-*` variants these components are
  written against, `no-scrollbar`, `scroll-fade` and `shimmer`. It comes from the `shadcn`
  devDependency, pinned exactly, which is also the CLI.
- **Our tooling leaves them alone.** oxlint (the `iterate/*` and jsx-a11y rules included), oxfmt
  and the `rules/` review rules exclude them, each list naming the files.
  `scripts/ci/shadcn-drift.test.ts` checks that the oxlint list, the oxfmt list, every `rules/`
  rule that would match one and the drift check's path filter cover all of them. knip needs no
  list: the `package.json` exports (`./components/*`, `./hooks/*`, `./lib/*`) make every file an
  entry, so it never reports their unused exports.

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

- **On a pull request** that touches a vendored file or an input of the CLI (`components.json`,
  `package.json`, `tsconfig.json`, `globals.css`), `.depot/workflows/shadcn-drift.yml` runs
  `shadcn-drift.ts check`. It asks the CLI's dry run for the exact content `add` would write, from
  shadcn's live registry, and fails on any file whose bytes differ, printing the diff. (The CLI's
  own "identical" ignores line endings and leading and trailing whitespace; the check does not.)
  The fix is a refresh, even when the difference is upstream moving rather than a hand edit. It is
  not a required check, and a pull request that leaves these files alone never runs it: it needs
  the network.
- **Daily**, `.depot/workflows/shadcn-upstream.yml` runs `shadcn-drift.ts report` on main and posts
  to Slack #ci when the set of files upstream has moved changes.

### Where the local changes went

| Was in                    | Now                                                                                                                                                                                                                                                                            |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| button: hover title       | Each icon-size `Button`, and each `SidebarTrigger` (upstream's icon-size Button), passes `title`; `iterate/icon-button-has-hover-text` requires it at the call site                                                                                                            |
| sheet: full width (#1883) | The `SheetContent` call site passes `data-[side=right]:w-full`. Below `sm`, a rule in `globals.css` makes every sheet full width anyway, keyed on its slot: one whose call site forgets, and the phone's sidebar sheet, which the vendored `Sidebar` renders with no className |
| sidebar: close (#1984)    | `SidebarNav` in `app-shell.tsx`: a same-tab link click closes the phone's sheet (shadcn-ui/ui#5561)                                                                                                                                                                            |
| command: ⌘K look (#2991)  | `app-shell-palette.tsx`: the classNames it passes, its own search row over cmdk's input, and Dialog's parts instead of `CommandDialog` (whose title sits outside the popup, on every page)                                                                                     |
| sonner: light only        | `AppProviders` renders `<Toaster theme="light" />`; `toast` is imported from `sonner`                                                                                                                                                                                          |
| dialog, sheet: close      | Upstream's: an sr-only "Close"                                                                                                                                                                                                                                                 |
| breadcrumb, label         | Upstream's                                                                                                                                                                                                                                                                     |

## AI Elements

`components/ai-elements/` is a fork of Vercel's AI Elements, refreshed by hand. It is copy-only
too, and Radix-only: the Base UI variant, vercel/ai-elements#450, is still open. So it is our code,
not vendored in the sense above.

Everything else here is our own code.
