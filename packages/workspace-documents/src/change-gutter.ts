import { EditorView, GutterMarker, gutter } from "@codemirror/view";
import { RangeSetBuilder, StateField, type EditorState, type Extension } from "@codemirror/state";
import { presentableDiff } from "@codemirror/merge";
import type { RangeSet } from "@codemirror/state";

/**
 * vscode/cursor-style change indicators for a NON-diff editor: a thin colored
 * bar in the gutter on every line that differs from the file's HEAD content —
 * green for added lines, blue for modified, red for a deletion boundary.
 * Recomputed per edit against the `original` snapshot the extension was
 * created with (the editor remounts per file/commit, so it never goes stale).
 */
export function changedLinesGutter(original: string): Extension {
  const field = StateField.define<RangeSet<GutterMarker>>({
    create: (state) => markersFor(original, state),
    update: (value, transaction) =>
      transaction.docChanged ? markersFor(original, transaction.state) : value,
  });
  return [
    field,
    gutter({
      class: "cm-changed-lines-gutter",
      markers: (view) => view.state.field(field),
    }),
    theme,
  ];
}

type ChangeKind = "added" | "deleted" | "modified";

class ChangedLineMarker extends GutterMarker {
  constructor(readonly kind: ChangeKind) {
    super();
  }

  // A child element, NOT a background on the gutter element: active-line
  // gutter themes (plainChrome's transparent .cm-activeLineGutter) override
  // gutter-element backgrounds, which would hide the bar on the cursor line.
  toDOM(): Node {
    const bar = document.createElement("div");
    bar.className = `cm-changed-line-bar cm-changed-line-${this.kind}`;
    return bar;
  }
}

const MARKERS: Record<ChangeKind, ChangedLineMarker> = {
  added: new ChangedLineMarker("added"),
  deleted: new ChangedLineMarker("deleted"),
  modified: new ChangedLineMarker("modified"),
};

function markersFor(original: string, state: EditorState): RangeSet<GutterMarker> {
  const kinds = new Map<number, ChangeKind>();
  for (const change of presentableDiff(original, state.doc.toString())) {
    if (change.fromB === change.toB) {
      // Pure deletion: mark the boundary line it happened at.
      const line = state.doc.lineAt(Math.min(change.fromB, state.doc.length)).number;
      if (!kinds.has(line)) kinds.set(line, "deleted");
      continue;
    }
    const kind: ChangeKind = change.fromA === change.toA ? "added" : "modified";
    const fromLine = state.doc.lineAt(change.fromB).number;
    const toLine = state.doc.lineAt(Math.min(change.toB, state.doc.length)).number;
    for (let line = fromLine; line <= toLine; line++) kinds.set(line, kind);
  }

  const builder = new RangeSetBuilder<GutterMarker>();
  for (const line of [...kinds.keys()].sort((a, b) => a - b)) {
    builder.add(state.doc.line(line).from, state.doc.line(line).from, MARKERS[kinds.get(line)!]);
  }
  return builder.finish();
}

const theme = EditorView.baseTheme({
  ".cm-changed-lines-gutter": { width: "3px" },
  ".cm-changed-line-bar": { width: "3px", height: "100%", borderRadius: "2px" },
  ".cm-changed-line-added": { backgroundColor: "#2da44e" },
  ".cm-changed-line-modified": { backgroundColor: "#0969da" },
  ".cm-changed-line-deleted": { backgroundColor: "#cf222e" },
});
