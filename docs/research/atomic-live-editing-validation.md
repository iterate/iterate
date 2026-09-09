# Atomic live Markdown editing: implementation and evidence

2026-09-09. The editable document remains the original Markdown file, including
Roughdraft Flavored Markdown comments and endmatter. Atomic supplies live preview
on the existing CodeMirror editor. There is no rich document serializer, separate
comment store, or new collaboration protocol.

## Why these small extensions exist

- RFM syntax is hidden while the anchored prose remains normal CodeMirror text.
  A mapped Markdown syntax tree preserves headings, lists and tables when an
  annotation wraps their Markdown markers.
- The comment composer holds a mapped source selection while focus is elsewhere.
  Submit transforms the current source into disjoint text changes, just like
  typing. Drafts remain in React through popover unmounts and resyncs.
- Native table cell decorations replace Atomic's serializing table widget. Cell
  edits, selection and presence all use CodeMirror's original text DOM.
- Rich/source switching reconfigures the same editor. Thread selection retains
  the language, syntax tree and view plugins; attribution redlines work in rich
  mode too.

## Dependency patches

[Atomic 0.6.2](https://github.com/kenforthewin/atomic-editor) is patched to decorate
the viewport plus 160 lines on each side, rather than walking the whole document
on every caret move. It also disables checkbox writes when CodeMirror is
read-only. Its clean upstream typecheck/build and 97 product tests passed.

[CodeMirror merge](https://github.com/codemirror/merge) is patched to observe its
existing timeout inside both substring-search loops. The application asks for a
50 ms diff budget. A pathological 1 MiB alternating rewrite changed from over
30 seconds to about 51 ms. A normal comment operation produced three disjoint
edits in about 0.3 ms. No document-size threshold forces whole-file replacement.

## Browser timing

Local Chromium, actual production rich-editor modules, one RFM comment and
frontmatter/endmatter, twenty edits per fixture. Each sample times the synchronous
CodeMirror state update plus view update, with a frame between samples. These are
not end-to-end network timings or mobile measurements.

| Markdown size | Initial update | Median edit | p95 edit |
| ------------- | -------------: | ----------: | -------: |
| 10 KiB        |          11 ms |      2.2 ms |   4.9 ms |
| 100 KiB       |          24 ms |       10 ms |    11 ms |
| 1 MiB         |         171 ms |       87 ms |    91 ms |

At 1 MiB, about 80 ms of the median is state/parsing work. Large files remain a
measurable limitation; they do not silently switch to source mode. The isolated
Atomic decoration patch also reduced a 1 MiB caret-selection view update from
about 80 ms to 1 ms. Browser dependency optimization was restarted before the
final integrated timings above.

## Correctness evidence

- Three official CodeMirror collaboration clients perform 750 competing edits,
  converge after each batch, retain a pending comment's passage, create the
  comment, then undo it without removing remote text.
- Server regression: an AI comment write around a 100 KiB document preserves an
  unconfirmed human edit inside the unchanged body.
- Native browser typing tests cover annotated passage boundaries, repeated
  insertion, whole-document navigation around hidden endmatter, and CDP IME
  composition at both edges and inside a passage. This is not proof of an actual
  iOS/Android IME candidate window or kinetic scrolling.
- Focused tests cover native tables, structural changes above tables, mapped
  headings/lists/tables, partial parser requests, remote cursor ordering,
  presentation identity, local undo, terminal read-only state, and composer
  draft restoration.

Claude Fable 5.1 reviewed both the design and the implementation through the
Claude CLI. Confirmed findings were fixed: document-edge snapping, table line
positions/staleness/trailing whitespace, unnecessary language replacement,
Node test bundling, and invalid browser-test assumptions. The review also led
to one shared operation/error path and removal of dead callback/test aliases.

The deployed two-browser walkthrough and rendered multiplayer video are still
pending. Local project app hosts incorrectly served OS's
Vite graph for Docs's virtual client entry, before reaching the editor; the
spec therefore targets a deployed preview. Temporary proxy experiments were
reverted.

## Known format limits

RFM cannot represent crossing inline anchors. Existing exact expected-failure
tests cover concurrent first-footer creation, overlapping anchors, and upstream
metadata/endmatter behavior; see
[the tracked task](../../tasks/roughdraft-concurrent-endmatter.md). This work does
not claim semantic merging of arbitrary Markdown/YAML edits. A stale full-file
write made after another edit was already confirmed still replaces that content.
