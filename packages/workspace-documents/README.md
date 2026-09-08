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
  onComment={async (selection, body) => saveSelection(selection, body)}
/>

<DocumentComments
  threads={threads}
  renderComment={(body) => <MarkdownBody source={body} />}
  onAction={async (action) => saveAction(action)}
/>
```

Both write callbacks return `Promise<boolean>`. Return `true` only after an
atomic write of the current document has landed. Return `false` for a stale
revision, unavailable connection, or rejected write: the built-in composer
keeps its draft so the user can retry.

For Roughdraft Flavored Markdown, use `useDocumentReview`:

```tsx
const review = useDocumentReview({ source, identity, busy, onTransform });

<DocumentPreview {...review.preview} />
<DocumentComments {...review.comments} />
```

The hook reads and writes RFM through `iterate/document-review`, maps display
ranges back to source ranges, and checks the selection's display revision before
it creates an anchored comment. `onTransform` receives a whole-file transform
and must apply it atomically to the latest live source. RFM cannot represent
crossing inline review ranges; the core rejects overlapping selections rather
than silently changing their meaning.
