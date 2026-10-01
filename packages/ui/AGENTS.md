# packages/ui

The UI kit every client app imports as `@iterate-com/ui/*`.

## Vendored shadcn components

shadcn's styled components are copy-only by design: there is no styled package. So packages/ui
vendors them. Each of these files is byte for byte what the pinned shadcn CLI writes through
`components.json` (style `base-nova`, on Base UI), and nobody edits one here: alert-dialog, avatar,
badge, breadcrumb, button, card, checkbox, command, dialog, dropdown-menu, empty, field, input,
label, native-select, select, separator, sheet, sidebar, skeleton, sonner, spinner, table, tabs,
textarea and tooltip in `src/components/`, plus `src/components/input-group.tsx` (command's
dependency) and `src/hooks/use-mobile.ts` (sidebar's).
core/os keeps its own copies of the ones it uses (avatar, button, checkbox, field, input, label,
native-select, separator and spinner) in `core/os/src/components/ui/`, written through its own
`components.json`, and imports nothing from here. Everything below applies to both folders.
`scripts/ci/shadcn-drift.ts` lists them (`VENDORINGS`).

- **Customise at the call site or in a wrapper** of our own, never in the file: a `className`, a
  prop, or a component here that renders the vendored one. The table below shows where each earlier
  local change went.
- **Keep the `dark:` classes.** Don't strip them. The apps are light mode only, and `globals.css`
  makes `dark:` never match (`@custom-variant dark (@media not all)`). Dev CSS keeps those rules
  inside `@media not all`; the production build drops the block, so they ship no bytes.
- **`cn` comes from the `cn` package** (shadcn's replacement for clsx + tailwind-merge), which the
  CLI's components import directly. Our own files import it the same way. `components.json`'s
  `aliases.utils` is `cn` itself, so the CLI rewrites a registry item's `@/lib/utils` import (the
  AI Elements items still use one) to `import { cn } from "cn"`; there is no `lib/utils.ts`.
- **`globals.css` imports `shadcn/tailwind.css`**: the `data-*` variants these components are
  written against, `no-scrollbar`, `scroll-fade` and `shimmer`. It comes from the `shadcn`
  devDependency, pinned exactly, which is also the CLI.
- **Our tooling leaves them alone.** oxlint (the `iterate/*` and jsx-a11y rules included), oxfmt
  and the `rules/` review rules exclude them, each list naming the files.
  `scripts/ci/shadcn-drift.test.ts` checks that the oxlint list, the oxfmt list, every `rules/`
  rule that would match one and the drift check's path filter cover all of them. knip needs no
  list: the `package.json` exports (`./components/*`, `./hooks/*`) make every file an
  entry, so it never reports their unused exports.

### Refresh

```sh
node scripts/ci/shadcn-drift.ts refresh  # shadcn add <every item> -o -y
git diff                                 # review what upstream changed
```

Review the diff instead of re-applying patches: there are none. Keep a dependency the CLI adds to
`package.json`, run `pnpm install`, then typecheck packages/ui and each app. To look at one file
first, without writing anything:

```sh
pnpm --dir packages/ui exec shadcn add button --dry-run --diff src/components/button.tsx
```

To bump the CLI, change the `shadcn` pin in the catalog (`pnpm-workspace.yaml`) and refresh. To
vendor another item, run `pnpm --dir <folder> exec shadcn add <item>`, then add it to that folder's
`items` in `VENDORINGS` (and any extra file it writes to `extraFiles`) and to the lists above.

### The drift check

- **On a pull request** that touches a vendored file or an input of the CLI in either folder
  (`components.json`, `package.json`, `tsconfig.json`, the stylesheet), `.depot/workflows/shadcn-drift.yml` runs
  `shadcn-drift.ts check`. It asks the CLI's dry run for the exact content `add` would write, from
  shadcn's live registry, and fails on any file whose bytes differ, printing the diff. (The CLI's
  own "identical" ignores line endings and leading and trailing whitespace; the check does not.)
  The fix is a refresh, even when the difference is upstream moving rather than a hand edit. It is
  not a required check, and a pull request that leaves these files alone never runs it: it needs
  the network.

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

Everything else here is our own code.

## The repo IDE

`src/components/repo-ide/` is a small IDE over one of a project's repos: a file tree, an editable
CodeMirror buffer with a diff against the last commit, staging, commit and history. Dash's
`/projects/<slug>/repos/<name>` is the first host; any app that holds the project's root context can
mount it the same way:

```tsx
import { RepoIde } from "@iterate-com/ui/components/repo-ide/repo-ide";
import { RepoIdeSearch } from "@iterate-com/ui/components/repo-ide/repo-ide-search";

// route: `validateSearch: RepoIdeSearch`, so the open file, the diff and the sidebar are the URL
const context = useContextStub(() => api.projects.get(project.id), [api, project.id]);
// in a flex row with `min-h-0 flex-1`; the IDE fills it
<RepoIde
  project={context.stub}
  projectId={project.id}
  repoPath="/repos/config"
  author={{ name: email, email }}
  search={search}
  onSearchChange={(patch) => navigate({ search: (prev) => ({ ...prev, ...patch }), replace: true })}
/>;
```

- **The host owns** the project stub, the route and the shell; the IDE owns everything inside its
  box. It imports no SDK at runtime (`project` is typed from `iterate/app`), no router, and nothing
  from an app. Its view state is the `search` prop, so a host without a router keeps it in state.
- **Parts that stand alone**: `repo-file-tree` (pierre, with git-status marks and a right-click
  menu), `repo-code-editor` (one file: language, gutter marks, inline diff), `markdown-preview` and
  `html-preview` (sandboxed), and `repo-client` (`useRepoFiles` follows a repo's commits;
  `readRepoFile`). Import the one you need by its path; the rest of the folder is the IDE's own.
- **Client only**: the working tree is read from `localStorage` while rendering, so mount the IDE
  where the page is not server rendered (a route under an `ssr: false` parent, as Dash's are, or
  `ClientOnly`).
- **CodeMirror loads when an editor first mounts** (every `@codemirror/*` import in the folder is
  a dynamic `import()` in `codemirror.ts`), so a page that never shows a file never pays for it. In
  a TanStack Start file route import `RepoIde` statically: the route's component is already its own
  chunk, prefetched on link hover, and a `lazy()` inside it only starts the download after the
  project opens. A host without route code splitting wraps it in `lazy()` itself.
- **Markdown preview** renders through streamdown, whose classes Tailwind finds only if the app's
  stylesheet scans it: `@source "../node_modules/streamdown/dist/*.js";` (dash's `styles.css`).
- **Text only**: the repo's reads and commits carry text, so images and archives show a notice.
- **React Doctor**: `npx react-doctor@latest --yes src/components/repo-ide/*.tsx src/components/repo-ide/*.ts`
  from this package scores 100; keep it there.

## Every app's shell

`src/apps/` is what each TanStack Start app's own shell files call with only what the app does
differently: `server.ts` (`appServerEntry`, the Worker entry, typed by `tsconfig.worker.json`
against the Workers types), `router.tsx` (`createAppRouter`), `document.tsx` (`AppDocument`) and
`head.ts` (`appHead`, with the one viewport every app has).
