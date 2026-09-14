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

The recording dependency is pinned to [Middlewright PR #44](https://github.com/iterate/middlewright/pull/44),
which balances FFmpeg cursor expressions so long walkthroughs can render. Its
77 video tests passed locally with subtitle-enabled FFmpeg. This changes test
recording only.

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

The first deployed walkthrough exposed a one-pixel remote-caret footprint that
wrapped at the end of a full-width table row. Cancelling that footprint keeps
the caret in the row (browser row height: 49.6 px → 31.4 px). The table test
also now double-clicks the visible word rather than the empty center of its
wide cell, and checks the native selection before replacing it. Peer-caret
labels are included in DOM text, so propagation checks scope to the cell and
independently require the exact saved Markdown rows.

Both hosted Bugbot findings were checked against source and reproductions:
multiline inline replacements are valid when supplied by a state field, and
a partial parser request must retain its original source origin even if its
first range is hidden. A new regression covers that hidden first range; a
browser exercise confirmed a multiline comment stays hidden during native edits.

The deployed two-browser walkthrough initially passed while its video exposed
a missed native-caret defect: Chrome collapsed Select All → ArrowRight to the
start of the last visible line when a hidden metadata block followed it. Later
pastes consequently prepended and concatenated text. The footer now uses an inline replacement, keeping the browser caret at the
visible body end. The saved-source assertion requires the tail
paragraphs in order with their blank lines intact. The native Chromium
reproduction passes; the deployed walkthrough tests this same EOF/paste path.

Preview telemetry also exposed a legacy live-state subscription fallback that
pinned its Durable Object after a Pager failure. That fallback is removed;
subscription failures remain visible and use the existing ten-second retry timer
for at most two retries. Success, manual refresh, or a new logical subscription
resets the budget. Focused tests cover recovery, exhausted attempts, and changing
subscriptions after exhaustion. Provider WebSocket lifecycle close records are
classified separately from application errors; exact deployment evidence and
the rendered two-client recording are attached to PR #2608.

## Known format limits

RFM cannot represent crossing inline anchors. Existing exact expected-failure
tests cover concurrent first-footer creation, overlapping anchors, and upstream
metadata/endmatter behavior. A new narrow expected failure reproduces a stale
client appending at the old EOF while another creates the first comment footer:
ordinary text rebasing preserves the append after the footer and invalidates
its YAML. The browser undo walkthrough waits for the peer to receive that
footer before proceeding; it does not claim to fix this race. See
[the tracked task](../../tasks/roughdraft-concurrent-endmatter.md). This work does
not claim semantic merging of arbitrary Markdown/YAML edits. A stale full-file
write made after another edit was already confirmed still replaces that content.
