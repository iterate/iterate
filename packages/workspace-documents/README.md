# Workspace documents

This package connects a collaborative workspace file to shared document UI. It
does not make storage decisions in the components.

Use the format-independent components from `@iterate-com/ui` when an app
already has plain display Markdown and annotation ranges:

```tsx
<DocumentPreview
  markdown={markdown}
  annotations={annotations}
  selectedAnnotationIds={selectedIds}
  onSelectAnnotations={setSelectedIds}
  onComment={(selection, body) => applySelection(selection, body)}
/>

<DocumentComments
  threads={threads}
  renderComment={(body) => <MarkdownBody source={body} />}
  onAction={(action) => applyAction(action)}
/>
```

Both callbacks return `boolean`: `true` means the edit was applied locally;
`false` keeps the composer draft. Synchronisation and recovery belong to the
host document, just as they do for typing. The components own no persistence.

For Roughdraft Flavored Markdown, use `useDocumentReview`:

```tsx
const review = useDocumentReview({ source, identity, busy, onTransform });

// Add these props to the editor's existing transport/path configuration:
<WorkspaceDocumentEditor {...editorProps} presentation="rich" review={review.editor} />
<DocumentComments {...review.comments} />

// A separate read-only Markdown preview is also available:
<DocumentPreview {...review.preview} />
```

The hook reads and writes RFM through `iterate/document-review`. The rich editor
holds a selected passage in CodeMirror source coordinates while the composer is
focused, mapping it through local and remote edits. Submission uses that current
range and the current file. The separate preview maps display ranges back to
source and checks its revision. `onTransform` receives a whole-file transform
and applies it to the current local editor with `applyTransform`. The editor uses
CodeMirror's diff to dispatch separate text changes, preserving unchanged prose
between a passage marker and its endmatter. Pending typing is included, and the
normal collaboration protocol handles attribution, retries and redlines. An
anchored comment from the separate preview requires its selection to match the current local
source; otherwise the draft is retained for reselection. Explicit UI actions
refresh the preview and discussion controls immediately; typing stays debounced.
Snapshot recovery also refreshes consumers immediately and cancels stale pending
reflections. Composers retain drafts when submit callbacks become unavailable.

`presentation="rich"` uses Atomic's live Markdown decorations; `"source"` exposes
the complete file for editing and repair. Switching reconfigures the same
EditorView, preserving the collaboration session, selection, and undo history.
Attribution redlines remain available in both modes. Tables use native CodeMirror
text spans, so cell typing and Tab navigation do not serialize or replace a table.
RFM syntax is hidden separately from editable prose. A projected syntax tree keeps
Markdown headings, lists, and tables structured even when a comment wraps them;
that tree is never serialized back into the file.

The two dependency patches are deliberately local: Atomic decorates a buffered
viewport instead of walking the whole file on every caret move, and disables
checkbox writes in read-only sessions. CodeMirror's diff observes its configured
deadline inside substring search. Ordinary file edits keep their disjoint changes
at every document size; there is no size-based replacement or source-mode fallback.

RFM cannot represent crossing inline review ranges; existing overlaps are
rejected locally. Concurrent edits can still produce invalid markup: two clients
creating the first endmatter can append two footers, and overlapping word/paragraph
comments can leak nested highlight delimiters into the preview. Both races are
pinned by precise expected-failure tests, alongside upstream metadata reformatting
and orphaned-endmatter handling, and tracked in
[tasks/roughdraft-concurrent-endmatter.md](../../tasks/roughdraft-concurrent-endmatter.md).
