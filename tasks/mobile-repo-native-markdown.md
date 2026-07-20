---
status: implementation-complete
size: large
branch: mobile-repo-native-markdown
replaces: https://github.com/iterate/iterate/pull/2065
---

# Native mobile repo workspace and Markdown rendering

## Status

The native repo collection, working-tree editor, Markdown preview, and chat rendering are implemented. Unit/type/export/prebuild verification and EAS development build `b783b444-28f5-45c0-b632-e6fd447608a0` pass; the physical-device interaction pass remains.

## Outcome

Turn repositories into a first-class mobile workspace. `/repos` should be the first destination in the project drawer, lead to the project's repositories, and open a practical file browser/editor with an explicit working tree and commit flow. Assistant chat messages and Markdown file previews should render as Markdown instead of plain text.

This supersedes the Expo Go proof of concept in #2065. It must build on the native app introduced by #2084 and must not retain a second Expo Go product path.

## Checklist

- [x] Add `/repos` as the first first-class destination in the project drawer and expose the project's repositories with the config repo first. _Implemented in the drawer and `repos.tsx`._
- [x] Build a native repo screen with file navigation, search, create/delete/discard actions, and an explicit batch commit flow. _Implemented by `repo.tsx`, the native tree drawer, and CodeMirror DOM editor._
- [x] Load and mutate real repository state through `project.repos.list()`, `project.repos.get(path)`, `Repo.listFiles()`, `Repo.readFile()`, and `Repo.commitFiles()`. _The collection and workspace call these project capabilities directly._
- [x] Preserve a lossless source editor for Markdown and other text files, including dirty-file and deletion tracking and remote-head conflict detection. _`repo-working-tree.ts` keeps source buffers and blocks commits after a head change._
- [x] Add `react-native-enriched-markdown` at a React Native 0.81-compatible version and use its viewer for Markdown file preview. _Pinned to 0.5.0 with math disabled in the Expo config plugin._
- [x] Render assistant chat messages with the enriched Markdown viewer while retaining selectable plain text for user messages. _Shared `Markdown` renders assistant output; user bubbles remain `Text`._
- [ ] Test the working-tree behavior, mobile typecheck/tests, web export/e2e surface, and native prebuild/autolinking. _45 unit tests, typecheck, web export, mobile Playwright, iOS prebuild, and the signed EAS development build pass; physical-device interaction remains._
- [x] Document that this native dependency requires installing a newly built development client before physical-device testing. _Added to the mobile README and replacement PR body._
- [x] Close #2065 with a note pointing to the replacement PR after the replacement is open. _Closed with a supersession note linking #2143._

## Physical-device follow-up fixes

- [x] Route away from the server picker immediately after OAuth succeeds. _The success transition now resets the ITX/query context and replaces the route with the project picker._
- [x] Prevent remembered projects leaking across deployments or sign-ins. _The storage key now includes the OS URL, auth issuer, and interactive OAuth client registration; boot also verifies the project remains in the current principal's catalogue._
- [x] Make mobile-created projects expose their config repo before they open. _Backfill now waits for `project/ready`, which is committed only after `/repos/config` becomes ready._
- [x] Highlight parsed TypeScript/JSON in chat without showing the model's duplicate fenced source. _Activities with an execution step show only that canonical parsed code through read-only CodeMirror, using its complete VS Code Dark theme._
- [x] Make copy confirmation non-blocking. _Copying a stream URL now shows a short-lived accessible in-app toast instead of an alert dialog._

## Product and implementation decisions

### Markdown editing must remain source-preserving

`react-native-enriched-markdown` is a good native renderer, but its rich text input does not represent all repository Markdown constructs. In particular, the compatible editor version cannot safely round-trip block structures such as fenced code, lists, tables, and blockquotes. Using it as the canonical editor could silently rewrite or discard valid source.

The repo workspace will therefore use:

- a source editor as the canonical, lossless editing surface;
- `EnrichedMarkdownText` as the rendered preview for `.md` files;
- `EnrichedMarkdownText` for assistant messages in chat;
- an explicit Preview/Source control rather than a rich-text abstraction that hides source changes.

Pin the library to `0.5.0`: that release supports React Native 0.81, while current releases require a newer React Native version than this app uses.

### Repositories are project navigation, not an example

The drawer should mirror the OS application's information architecture: `/repos` is a stable project destination and appears before Examples and Approvals. The repository collection should list every repo exposed by the project capability, while making the config repo the obvious first choice.

### Working tree behavior

Edits remain local until the user commits them together with a message. Opening a repo records its head; if the remote head changes before commit, the app must stop and explain the conflict instead of silently overwriting newer work. Discarding restores remote content, and deletes remain visible as pending changes until committed or discarded.

## Verification notes

The browser-compatible surface can cover navigation and core interaction, but it does not prove that the native Markdown module is present in the installed iOS binary. Final physical-device verification requires an EAS development build produced after adding the dependency.
