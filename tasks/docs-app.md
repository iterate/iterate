---
status: in-progress
size: large
---

# Docs: team docs instead of Notion

Status: parts 1 and 2 built. Part 1: a docs app you can write in. Part 2: live co-editing through
a per-doc processor from `@iterate-com/docs`, which also autosaves and takes in commits made
elsewhere. The browser spec (two people, an agent's commit) runs on the PR preview only; locally the
package has unit tests and the page was checked in a harness. Not done: the `docs` Doppler project
(prd deploy), docs.iterate.com, comments.

## Goal

The team writes specs, plans and meeting notes here instead of Notion, and agents can read, edit
and comment on the same docs. Success = the next five docs we'd have put in Notion go here.

Not the goal: Notion parity. The thing Notion can't do is agents working on the same files, in git.

## Decisions

- **Docs are markdown files in their own repo, `/repos/docs`.** Not the config repo: a config commit
  republishes the project's site.
- **The editor edits the text itself** (CodeMirror 6), with Atomic's Obsidian-style live preview
  (`@atomic-editor/editor`, the library the old app used). Not a tree editor (Lexical and friends):
  see "Rejected: a tree editor".
- **Served like Notes:** a project's config worker serves the `docs` routing slug, so it's
  `docs--<project>.iterate.app`, and PR previews work with no setup. No OAuth client, no sign-in of its
  own. docs.iterate.com comes later as a Host rule in the iterate project's config worker.
- **Co-editing with Yjs.** One Y.Text per open doc holds the file's bytes. A per-doc server holds the
  Y.Doc while anyone is editing and autosaves it with `commitFiles({parent})`. Git stays the source
  of truth; the Y.Doc is a session buffer.
- **The per-doc server is a facet from a package the project installs** (`@iterate-com/docs`, like
  agents, voice and the GitHub sync). Facets refuse WebSockets (`FACET_NO_UPGRADE`), so Yjs updates
  ride the browser's existing capnweb socket as ephemeral events on the doc's context.
- **Commits from elsewhere** (agents, git) get merged like git against the live text, and the
  difference goes into the Y.Text as character-level edits, so nobody's typing is lost.
- **Comments** (later): events on the doc's stream, never in the `.md`, pointing at text by quoting
  it (exact + prefix + suffix over the file text). Keyed by path; copied on rename. Work in both
  Rich and Markdown mode. No `@agent` wake for now.
- When docs ships, `apps/notes` goes.

## Assumptions (made without asking; change them if wrong)

- The UI copies apps/notes's shell (`ProjectAppShell`, base path handling, proxied server) and its
  config-worker pattern. Docs' config worker serves `docs` and nothing else; a real project config
  worker would merge it with its other routes.
- One page per doc at `/projects/$slug/$path` (path relative to `/repos/docs`, `.md` included), and
  `/projects/$slug` lists every `.md` in the repo with a "New doc" box. No folders UI, rename or
  delete yet.
- Frontmatter shows as a read-only properties block in Rich mode; edit it in Markdown mode.
- Autosave waits 1.5 s after the last keystroke (at most 8 s). Commit message
  `docs: edit <path>`, `Co-authored-by:` trailers when several people typed. No autosquash yet.
- Part 1's autosave runs in the browser. It's thrown away in part 2 once the facet autosaves.
- The per-doc server is a processor (a facet the doc's context pushes events to), one per doc on
  `/docs/<path>`, plus one on the project's root that tells open docs about commits. The Docs page
  installs both when a doc opens (`ensureDoc`), pinned to the package build of the app's own commit.

## Part 1: a docs app you can write in (commit 1)

- [x] `apps/docs` from `apps/notes`: proxied server, base path, root, `_auth`, projects index _(Notes' base-path helper moved to `packages/ui/src/apps/base-path.ts` for both)_
- [x] Registered everywhere Notes is: `envs.ts` `docsEnvs` + `PREVIEW_DEPLOYMENT_APPS`,
      `FIRST_PARTY_APPS`, `start-app-config` `urls`, `pnpm-workspace.yaml`, `knip.ts`, `doppler.yaml`,
      `preview-paths.ts` and the preview workflows' `paths`, `deploy-docs.yml` _(plus the prd fault
      alarm, `playwright.config.ts`, `DOCS_BASE_URL` in `apps/os/scripts/preview.ts`, and the docs that
      list the clients; the `docs` Doppler project itself still needs creating, see log)_
- [x] `apps/docs/config-worker.ts` serving the `docs` routing slug _(fetches through to `docs.iterate.workers.dev`)_
- [x] Doc list + "New doc" (creates `/repos/docs` idempotently, like Notes creates its repo) _(`projects.$slug.index.tsx`)_
- [x] Editor: CodeMirror + Atomic live preview (inline preview, tables, images), Rich / Markdown
      switch top right, formatting bar (undo/redo, bold, italic, strike, code, lists, checklist,
      block type, link, table, divider) _(`src/editor/extensions.ts`, `src/components/doc-editor.tsx`)_
- [x] The papercuts from last time (2026-09-10): Cmd-B/I/E/K do bold/italic/code/link (not the
      sidebar), Tab indents list items and keeps focus, inline code is readable _(`stopPropagation`
      on the bindings; `indentWithTab`; Atomic's colours mapped to the app theme)_
- [x] Frontmatter as a properties block in Rich mode _(`src/editor/frontmatter.ts`)_
- [x] Autosave: commit with the tip as parent; refused (someone else committed) → re-read, 3-way
      merge (diff3), commit again; a status line says where it stands _(`src/editor/doc-session.ts`)_
- [x] `specs/docs/docs.spec.ts`: create a doc, type with shortcuts, it autosaves, a reload shows it
      _(also: the sidebar stays put on Cmd-B, and a commit made elsewhere merges in)_

## Part 2: co-editing (commit 2)

- [x] `packages/docs` → `@iterate-com/docs` (pkg.pr.new): the doc facet (Y.Doc in its storage, one
      Y.Text `file`), and `ensureDocs(itx)` that installs it into a project the way `ensureAgents`
      does _(`DocProcessor` in `processor.ts`, its Y.Doc as an updates table in the facet's SQLite;
      `ensureDoc(project, path, version)` in `install.ts`, per doc rather than per project)_
- [x] Yjs over the platform: browsers append ephemeral update/awareness events on the doc's
      context and subscribe to them; a late joiner gets a snapshot from the facet and catches up by
      state vector _(`frames.ts`; the facet's `sync(stateVector)`; the page's `src/editor/collab.ts`)_
- [x] The browser binds CodeMirror to the Y.Text with `y-codemirror.next` (cursors and names via
      awareness) _(`doc-session.ts`; "Also here: …" above the editor; undo is Yjs's, your own edits only)_
- [x] Autosave moves into the facet (Co-authored-by from the events' principals); the browser's
      autosave goes _(`DocProcessor#save`; `apps/docs/src/editor/merge.ts` deleted)_
- [x] Commits from elsewhere reach the facet (`repo/commit-completed`) and merge in character by
      character _(the root's `DocsProcessor` (`root.ts`) sends `docs/commit-noticed` to opened docs
      the commit changed; `DocProcessor#catchUp` merges and sends the edit to every tab)_
- [x] Spec: two people edit one doc live; an agent's commit shows up without a reload and without
      losing either person's typing _(`specs/docs/docs.spec.ts`; the merge-without-loss cases are
      `packages/docs/src/processor.test.ts`)_

## Sidebar (asked for 2026-09-29, after trying the preview)

- [x] The docs as a tree in the sidebar: folders from paths, the open doc highlighted and its folders
      open, "New doc" at the top _(`src/components/docs-nav.tsx`; folders are `<details>`)_
- [x] It follows the repo: a doc someone or an agent adds shows up without a reload _(`src/lib/doc-list.ts`
      subscribes to the root's `repo/commit-completed`)_
- [x] "New doc" takes `folder/title` _(`newDocPath`, `newDocHeading` in `src/lib/docs-repo.ts`)_
- [x] ⌘K finds a doc by name, one in a closed folder included _(the shell's palette reads the sidebar's
      rows; `specs/docs/sidebar.spec.ts`)_
- [x] Code blocks: syntax highlighting, and a readable fence language name _(`extensions.ts`)_

## Later

- docs.iterate.com (Host rule in the iterate project's config worker)
- Comments (design above; the prototype has a working version)
- Tree: rename (copies comments), delete, move (drag), from the sidebar's rows
- Images: paste/drop → `itx.files`
- `/` menu over the formatting bar's commands
- Notion import (only the pages we still use)
- Search inside docs, not just their names (client-side is fine at our size)
- Autosquash: `main` only takes a commit whose parent is the tip, so folding autosaves needs
  something like `commitFiles({replaces: tipOid})`; or autosave less often, since the facet keeps
  the Y.Doc
- Delete `apps/notes` (and `notesEnvs`, `deploy-notes.yml`)

## What we delete (vs the old apps/docs and Notion)

From the old `apps/docs` (≈15k non-test lines): comments inside the file (Roughdraft/CriticMarkup
plus YAML endmatter, the cause of all five of its known-failing tests), workspaces as a user
concept (overlays, per-repo commit buttons, jam, owners), the CodeMirror collab op log (Yjs
replaces it), the tasks kanban, the agent feed pane, tracked changes, HTML documents, the diff view,
and the Docs worker → config worker → second OS connection chain.

From Notion, for now: databases (frontmatter is page properties), templates, AI in the editor,
embeds, synced blocks, icons, backlinks, @-mentions, permissions beyond "project member", public
pages, offline, a mobile app, a version-history UI.

## Rejected: a tree editor

Lexical + `@lexical/mdast` + Yjs was prototyped side by side with the text model (2026-09-25..28,
`prototypes.ignoreme/docs` in the root checkout, gitignored):

|                                                             | Text (chosen)                          | Tree (Lexical)                                       |
| ----------------------------------------------------------- | -------------------------------------- | ---------------------------------------------------- |
| Agent rewords a sentence while someone, offline, adds to it | both kept                              | the offline addition is lost (the block is replaced) |
| Co-editing server bundle                                    | 29 kB gz                               | 197 kB gz (headless Lexical + mdast)                 |
| Turning the live doc into markdown                          | `toString()`                           | headless editor + re-serialize only changed blocks   |
| Markdown it doesn't know (images, footnotes, HTML comments) | kept, it's text                        | dropped unless we add support                        |
| Comments in both modes                                      | one set of offsets                     | quotes over rendered text + mapping                  |
| Feel                                                        | Obsidian: syntax shows near the cursor | Notion: WYSIWYG                                      |

Also tried: SilverBullet's live preview (MIT, copied in as a third variant). It felt fine; Atomic
won because it's a package rather than ~1.5k copied lines, and last time's complaints were
integration papercuts (shortcuts, Tab, colours), not Atomic itself. The editor look is one swappable
set of CodeMirror extensions, so switching later is cheap.

## Unknowns

- Ephemeral event size and rate limits with a few people typing. Each tab sends one frame at a time
  and merges what's typed meanwhile, so a burst is a handful of frames.
- Facets reset 60 s after their context goes quiet and on every deploy: fine for a session buffer if
  the Y.Doc is in facet storage and autosave flushes on quiet. Needs the slow e2e rows.
- Installed code is pinned per project; nothing re-installs it when the package changes.
- Commit latency: `commitFiles` pushes to Artifacts and reads the whole tip. Measure on a preview.
- Atomic 0.6.2 is still the latest; the old app patched it twice (decorate only the visible range
  for big docs; disabled checkboxes). Expect to bring the first patch back.

## Implementation log

- 2026-09-28, part 1. `apps/docs` is Notes' shell plus an editor. `DocSession` owns the CodeMirror
  view and the autosave, and React reads it through `useSyncExternalStore` (no state hooks). The
  "New doc" button is a react-query mutation.
- Checked by hand in a gitignored harness (`apps/docs/harness.ignoreme/`: the real `DocEditor` over
  an in-memory repo): Cmd-B, Tab nesting with focus kept, autosave, a refused save merged with
  someone else's non-conflicting commit, and a conflicting one keeping ours. The spec's keystrokes
  were replayed there to pin its expected text.
- Enter twice after a nested list item lifts it a level (CodeMirror's markdown keymap) instead of
  leaving the list, so the spec's second edit extends an earlier line instead.
- Before prd: `doppler projects create docs`, then a `prd` config inheriting `_shared.prd`
  (`.agents/skills/creating-an-app/references/doppler.md`). Not done here: shared infra.
- Local `scripts` tests `ci/toolchain.test.ts` and `ci/tracing/tracing.test.ts` fail on macOS's bash
  3.2 (`inherit_errexit`); unrelated, green on CI's Linux.
- 2026-09-28, part 2. The app package was also named `@iterate-com/docs`; renamed it
  `@iterate-com/docs-app` (like `agents-app`, `voice-app`) so the new package keeps the name.
- A dropped ephemeral frame is healed by syncing again, both ways, by state vector: the page does it
  when Yjs holds back an update that needs one it never got, after a failed send, and after each
  save (which also covers the processor having missed a tab's frame). Subscription ranges weren't
  usable for this: they jump over every event the subscription doesn't consume.
- The editor opens read-only on the loaded text ("Opening…") and swaps to the live state once
  synced, so a keystroke can't land in a local-only doc.
- Who's here: a tab announces itself after its first sync, and anyone who sees a new tab answers
  with theirs, instead of waiting up to 15 s for awareness's heartbeat.
- Checked by hand in the harness (now two `DocEditor`s over an in-page stand-in for the processor):
  typing reaches the other editor with the typist's cursor and name, undo takes back only your own
  line, an agent's commit shows up in both. The spec's second-person keystrokes were replayed there.
- On the preview a doc page failed with "Unable to preload CSS for …/assets/projects._slug-….css":
  Atomic's stylesheet, imported from `extensions.ts`, became a CSS file of its own, which Vite
  preloads from the origin's root, outside the project's base path. It's now `@import`ed by
  `src/styles.css`, the one stylesheet the page already links under its base path. The spec caught
  it; the harness didn't (no base path there).
- Then the doc's processor failed to load on the preview: "…/node-diff3@3.2.1/es2022/node-diff3.js
  does not provide an export named 'diff3Merge'". The platform fetches a loaded package's npm
  dependencies from esm.sh (`target=es2022`), which builds node-diff3 from its `browser` export, an
  IIFE whose only export is `default`. node-diff3 is now bundled into the package (tsdown
  `alwaysBundle`, a devDependency); yjs and diff come from esm.sh fine. The package's unit tests run
  under node, which picks `import`, so they couldn't catch it.
- Then "not a doc's context: prj_….iterate/docs/abc.md": the host read the doc's path from the
  facet's `iterateContextName`, which is the project-qualified name, not the path. The processor now
  asks `itx.whoami()` for its path as the doc loads (as the agents processor does), and the unit
  tests' fake itx answers `whoami` the same way. Checked the other platform assumptions against the
  installed packages that already work: the `itx.repos ⇒ itx.builtins.cd('/').repos` rule and the
  root's `repo/commit-completed` are github-sync's exact spellings.
- The old app's sidebar (before #2837) was a workspace switcher, Docs/Tasks views and a
  `@pierre/trees` file tree with git-status badges and a context menu. The workspace parts and the
  badges have no counterpart here (no overlays, autosave), so the new sidebar is the tree alone.
  ⌘K came free: the shell's palette lists the sidebar's rows, so a folder is a `<details>` (its
  closed rows stay in the page) and a doc in a folder carries the folder as hidden text, the
  palette's "detail". In the editor ⌘K stays the link shortcut; the sidebar's Search row opens the
  palette from anywhere.
- Package test "two people's edits land in one autosave commit" was order-flaky: two tabs inserting
  at the same spot at once get a random order in Yjs (by client id), which is correct. The test now
  has Jonas type after he sees Misha's line.
