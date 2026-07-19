---
status: in-progress
size: large
branch: mobile-repo-native-markdown
replaces: https://github.com/iterate/iterate/pull/2065
---

# Native mobile repo workspace and Markdown rendering

## Status

The replacement is specified against the merged native development-build app. Implementation has not started. The main product decision is that repository Markdown remains lossless source text: enriched Markdown is used for rendering and preview, while the source editor remains capable of preserving every Markdown construct.

## Outcome

Turn repositories into a first-class mobile workspace. `/repos` should be the first destination in the project drawer, lead to the project's repositories, and open a practical file browser/editor with an explicit working tree and commit flow. Assistant chat messages and Markdown file previews should render as Markdown instead of plain text.

This supersedes the Expo Go proof of concept in #2065. It must build on the native app introduced by #2084 and must not retain a second Expo Go product path.

## Checklist

- [ ] Add `/repos` as the first first-class destination in the project drawer and expose the project's repositories with the config repo first.
- [ ] Build a native repo screen with file navigation, search, create/delete/discard actions, and an explicit batch commit flow.
- [ ] Load and mutate real repository state through `project.repos.list()`, `project.repos.get(path)`, `Repo.listFiles()`, `Repo.readFile()`, and `Repo.commitFiles()`.
- [ ] Preserve a lossless source editor for Markdown and other text files, including dirty-file and deletion tracking and remote-head conflict detection.
- [ ] Add `react-native-enriched-markdown` at a React Native 0.81-compatible version and use its viewer for Markdown file preview.
- [ ] Render assistant chat messages with the enriched Markdown viewer while retaining selectable plain text for user messages.
- [ ] Test the working-tree behavior, mobile typecheck/tests, web export/e2e surface, and native prebuild/autolinking.
- [ ] Document that this native dependency requires installing a newly built development client before physical-device testing.
- [ ] Close #2065 with a note pointing to the replacement PR after the replacement is open.

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
