---
status: implemented, needs live device pass
size: medium
branch: mobile-ide-poc
---

# Mobile repo IDE POC

**Status summary:** the selected POC direction is implemented: a native slide-out repo tree powered by `react-native-tree-multi-select`, CodeMirror in an Expo DOM WebView, and a web-OS-shaped Git rail/commit panel. Browse/search/open/edit/create/delete/discard/batch commit work, and tapping a file dismisses the drawer. Browser interaction evidence, typecheck, lint, tests, and bundle verification pass. Missing: an on-phone pass against a real project.

## Ask

Worktreeify an experimental IDE for the mobile app. It does not need desktop feature parity; it should make managing repo files from the phone plausible. Search broadly for usable off-the-shelf React Native code editors and file trees, and use a WebView if the native ecosystem cannot provide a credible editing experience.

## Prototype question

Can a phone-native repo browser/editor be useful enough with an off-the-shelf React Native component, or should Iterate explicitly use a WebView-backed web editor?

The POC should make the answer visible in the running app, not merely assert it in notes. After comparing three initial layouts, commit to one direction rather than retaining a switcher: a native slide-out file drawer over a CodeMirror editor, with source control available from a Git icon in the drawer rail.

## Assumptions

- “My repo” means the selected project's config repo (`itx.projects.get(projectId).repo`), because that is the repo whose commits drive the project worker/site and it already exposes `listFiles`, `readFile`, and `commitFiles`.
- POC mutations are real and explicit: edits remain local until the user taps Commit and supplies a commit message. There is no autosave-to-main.
- v1 supports UTF-8 text files only. Binary preview, image editing, branches, diffs, merge-conflict resolution, LSP, shell access, and GitHub sync are out of scope.
- File operations required for the spike: browse/search paths, open, edit, create, delete, review pending changes, and commit them as one batch.
- Expo Go compatibility is preferred. If the best native package requires a custom native build, that is evidence against it for this POC rather than permission to silently change the mobile app's distribution model.
- This is throwaway prototype code. The durable output is the research/verdict recorded here; productionizing the winner requires a separate pass with tests and product-grade failure handling.

## Checklist

- [x] Research maintained React Native code editors, syntax-highlighting text inputs, file-tree components, and WebView-hosted editors — record license, maintenance/activity, Expo compatibility, mobile ergonomics, and integration risks with primary-source links — _see “Research verdict”; registry and upstream evidence checked 2026-07-17_
- [x] Select an editor engine and document why the rejected options are not credible for this POC — _CodeMirror 6 through Expo DOM/WebView; Monaco and the native overlay editor rejected for explicit mobile/cursor limitations_
- [x] Add a project-scoped IDE entry point to the mobile app — _IDE action in the project chat header opens `/project/[projectId]/ide-prototype`_
- [x] Load the config repo's file list and text contents through the existing authenticated itx session — _`project.repo.listFiles()` plus lazy `readFile()`; known binary extensions are counted and hidden_
- [x] Support browse/search, open, edit, create, delete, pending-change review, and a user-triggered batch commit — _in-memory store builds one explicit `repo.commitFiles()` batch; no autosave-to-main_
- [x] Collapse the layout exploration to one selected interaction and delete the losing variants — _native animated drawer over CodeMirror; `>>` opens it, `<<` hides it, and selecting a file hides it automatically_
- [x] Use the researched tree library rather than a flat file list — _`react-native-tree-multi-select` supplies FlashList virtualization and expansion state; a custom row removes its checkbox/drag product model_
- [x] Put source control in the drawer's web-OS-shaped Git rail — _Git branch icon carries the pending count and opens commit message, change list, discard, and batch commit controls_
- [x] Keep prototype state in memory and clearly label the surface as experimental — _module store only; yellow experimental banner and prototype filenames/comments_
- [x] Verify typecheck, formatting/lint, Expo bundle health, and the focused mobile tests — _mobile typecheck + 30 tests, root lint, and `expo export --platform ios` all pass; DOM bundle is 1.21 MB and native Hermes bundle 4.57 MB with the tree/icon dependencies_
- [ ] Exercise the POC against a real local/preview project on a phone
- [x] Capture phone-width interaction evidence for the PR — _390×844 browser pass covers drawer animation, folder tree, file-open dismissal, CodeMirror edit, Git dirty badge, change review, and demo commit_
- [x] Record the verdict and the smallest credible production follow-up — _provisional verdict: hybrid native chrome + CodeMirror; production follow-up must compare Expo DOM with an OTA-friendly manually bundled WebView after the phone pass_

## Research verdict (2026-07-17)

### Editor

| Candidate | Evidence | Verdict |
| --- | --- | --- |
| [`@rivascva/react-native-code-editor`](https://github.com/RivasCVA/react-native-code-editor) | MIT, pure React Native `TextInput` over `react-syntax-highlighter`; npm's latest is 1.2.2 from 2022 and upstream's last code push was 2023. Its own README warns that cursor and highlighted text commonly misalign and require app-specific line-height tuning. | Useful as the deliberately bad baseline, not a credible editor dependency. Overlay alignment, selection, IME, and large-file rendering are precisely the hard parts an editor should own. |
| [`react-native-code-highlighter`](https://github.com/gmsgowtham/react-native-code-highlighter) / [`react-native-syntax-highlighter`](https://github.com/conorhastings/react-native-syntax-highlighter) | MIT and native-rendered, but both are display components, not editable controls. The former is active; the latter is old. | Good for read-only snippets only. Combining either with a transparent `TextInput` recreates the rejected overlay architecture. |
| [`@10play/tentap-editor`](https://github.com/10play/10Tap-Editor) | Active MIT WebView editor with Expo support, but it is a Tiptap/ProseMirror rich-text editor. | Strong evidence that serious RN editing surfaces already choose WebView; wrong document model for source code. |
| [Monaco](https://github.com/microsoft/monaco-editor) | Active MIT editor, but its official FAQ says mobile browsers and mobile web app frameworks are unsupported. It also brings a much larger worker/model surface than this POC needs. | Reject even in WebView. “It renders” is not the same as supported touch/IME behavior. |
| [CodeMirror 6](https://codemirror.net/) | MIT, actively maintained, explicitly advertises mobile support using platform-native selection/editing. Its [changelog](https://codemirror.net/docs/changelog/) continues to ship iOS composition/selection and Android context-menu fixes. | **Chosen.** It is the only investigated code editor whose upstream explicitly owns mobile input behavior. |

### Native/WebView bridge

- [`react-native-webview`](https://github.com/react-native-webview/react-native-webview) is active, MIT, Expo-compatible, and included in Expo Go. [Expo SDK 54 recommends 13.15.0](https://docs.expo.dev/versions/v54.0.0/sdk/webview/), which is pinned here.
- [Expo DOM components](https://docs.expo.dev/guides/dom-components/) bundle ordinary React DOM dependencies into an offline WebView, support Expo Go, and provide typed asynchronous native actions. That lets CodeMirror stay normal web code without a handwritten HTML/JS bundling pipeline, so it is ideal for the spike.
- The bridge is deliberately narrow: native owns auth, repo RPCs, file chrome, and commit state; the DOM component receives one path/value and emits serialized content changes. No itx capability or credentials enter the WebView.
- Production caveat: Expo currently says DOM components do **not** support OTA updates, props cross an asynchronous JSON bridge, and DOM JS parses more slowly than Hermes. If this interaction wins, production should compare this exact component with a manual `react-native-webview` that embeds a prebuilt CodeMirror asset (OTA-friendly) before adopting Expo DOM permanently.

### File tree

- [`react-native-tree-multi-select`](https://github.com/JairajJangle/react-native-tree-multi-select) is a surprisingly credible active MIT option: Expo Go support, FlashList virtualization, search, custom rows, accessibility, and drag/drop. Its default product model is checkbox multi-selection plus reparenting, but its `CustomNodeRowComponent` retains the library's expansion/virtualization behavior while handing the whole row interaction to us.
- The selected POC uses that custom-row seam for a conventional repo tree: folders expand, files open, dirty files get a marker, and checkbox/drag affordances are absent. This is more dependency than a hand-written flat list, but it answers the user's hierarchy question directly and gives large repos a credible virtualization path.

## Implementation log

- 2026-07-17: created from `origin/main` in `/Users/mmkal/src/worktrees/iterate/mobile-ide-poc`. Scope intentionally favors learning about editor technology and phone interaction over desktop IDE parity.
- 2026-07-17: selected CodeMirror 6 in Expo DOM after upstream/registry research. The initial three-layout comparison shared one in-memory store. `expo export` successfully emitted the native bundle plus the offline DOM editor bundle, proving the SDK 54/Expo Go packaging path rather than assuming it.
- 2026-07-17: user selected one direction. Removed the switcher and losing layouts; installed `react-native-tree-multi-select`, its Expo-compatible FlashList peer, and Expo icons. The winner uses a native animated drawer, custom virtualized tree rows, and a files/source-control icon rail modeled on web OS.
- 2026-07-17: headed browser pass at 390×844 through `?demo=1`: collapsed/expanded the drawer, opened a file (which dismissed the drawer), edited CodeMirror content, observed the Git badge, reviewed the modified file, and completed a simulated commit back to a clean tree. Screenshots: `docs/pr-assets/mobile-ide-poc-{drawer,git}.png`. Browser console had React Native Web's style/pointer-event deprecations and its expected JS fallback for `Animated`; no application exception. This proves rendered layout/state and browser CodeMirror behavior, not iOS WebView touch/IME or a real itx mutation; that remains the required phone pass.
