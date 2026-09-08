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

<DocumentPreview {...review.preview} />
<DocumentComments {...review.comments} />
```

The hook reads and writes RFM through `iterate/document-review`, maps display
ranges back to source ranges, and checks the selection's display revision before
it creates an anchored comment. `onTransform` receives a whole-file transform
and applies it to the current local editor with `applyTransform`. The editor uses
CodeMirror's diff to dispatch separate text changes, preserving unchanged prose
between a passage marker and its endmatter. Pending typing is included, and the
normal collaboration protocol handles attribution, retries and redlines.

RFM cannot represent crossing inline review ranges; existing overlaps are
rejected locally. Concurrent edits can still produce invalid markup: two clients
creating the first endmatter can append two footers. The known race is pinned by
an expected-failure test and tracked in
[tasks/roughdraft-concurrent-endmatter.md](../../tasks/roughdraft-concurrent-endmatter.md).
