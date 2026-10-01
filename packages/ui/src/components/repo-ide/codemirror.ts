// CodeMirror for the repo IDE, loaded when an editor first mounts: the page that shows a repo pays
// for the editor only then, and a file's language pack loads with the file. Everything below takes
// the loaded modules (`CodeMirror`) rather than importing them, so no module of the IDE holds
// CodeMirror in its static imports.
import type { EditorState, Extension, RangeSet } from "@codemirror/state";
import type { GutterMarker } from "@codemirror/view";
import type { RepoFileLanguage } from "./repo-file-kinds.ts";

async function loadLanguage(language: RepoFileLanguage): Promise<Extension> {
  switch (language) {
    case "css":
      return (await import("@codemirror/lang-css")).css();
    case "html":
      return (await import("@codemirror/lang-html")).html();
    case "javascript":
      return (await import("@codemirror/lang-javascript")).javascript({ jsx: true });
    case "typescript":
      return (await import("@codemirror/lang-javascript")).javascript({
        jsx: true,
        typescript: true,
      });
    case "json":
    case "jsonc":
      return (await import("@codemirror/lang-json")).json();
    case "markdown":
      return (await import("@codemirror/lang-markdown")).markdown();
    case "sql":
      return (await import("@codemirror/lang-sql")).sql();
    case "yaml":
      return (await import("@codemirror/lang-yaml")).yaml();
    case "text":
      return [];
  }
}

export async function loadCodeMirror(language: RepoFileLanguage) {
  const [view, state, merge, setup, themes, languageSupport] = await Promise.all([
    import("@codemirror/view"),
    import("@codemirror/state"),
    import("@codemirror/merge"),
    import("codemirror"),
    import("@fsegurai/codemirror-theme-bundle"),
    loadLanguage(language),
  ]);
  return {
    view,
    state,
    merge,
    basicSetup: setup.basicSetup,
    vsCodeLight: themes.vsCodeLight,
    languageSupport,
  };
}

export type CodeMirror = Awaited<ReturnType<typeof loadCodeMirror>>;

type ChangeKind = "added" | "deleted" | "modified";

/** vscode-style change indicators for a plain editor: a thin coloured bar in the gutter on every
 *  line that differs from `original`: green for added lines, blue for modified, red at a deletion.
 *  Recomputed per edit against the snapshot it was made with. */
function changedLinesGutter(cm: CodeMirror, original: string): Extension {
  const { GutterMarker: GutterMarkerBase, EditorView, gutter } = cm.view;
  const { RangeSetBuilder, StateField } = cm.state;

  class ChangedLineMarker extends GutterMarkerBase {
    readonly kind: ChangeKind;

    constructor(kind: ChangeKind) {
      super();
      this.kind = kind;
    }

    // a child element, not a background on the gutter element: the active-line gutter theme
    // overrides gutter backgrounds, which would hide the bar on the cursor line
    toDOM(): Node {
      const bar = document.createElement("div");
      bar.className = `cm-changed-line-bar cm-changed-line-${this.kind}`;
      return bar;
    }
  }
  const markers: Record<ChangeKind, ChangedLineMarker> = {
    added: new ChangedLineMarker("added"),
    deleted: new ChangedLineMarker("deleted"),
    modified: new ChangedLineMarker("modified"),
  };

  const markersFor = (state: EditorState): RangeSet<GutterMarker> => {
    const kinds = new Map<number, ChangeKind>();
    for (const change of cm.merge.presentableDiff(original, state.doc.toString())) {
      if (change.fromB === change.toB) {
        // a pure deletion marks the line it happened at
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
    for (const line of [...kinds.keys()].toSorted((a, b) => a - b)) {
      const from = state.doc.line(line).from;
      builder.add(from, from, markers[kinds.get(line)!]);
    }
    return builder.finish();
  };

  const field = StateField.define<RangeSet<GutterMarker>>({
    create: (state) => markersFor(state),
    update: (value, transaction) =>
      transaction.docChanged ? markersFor(transaction.state) : value,
  });
  return [
    field,
    gutter({ class: "cm-changed-lines-gutter", markers: (view) => view.state.field(field) }),
    EditorView.baseTheme({
      ".cm-changed-lines-gutter": { width: "3px" },
      ".cm-changed-line-bar": { width: "3px", height: "100%", borderRadius: "2px" },
      ".cm-changed-line-added": { backgroundColor: "#2da44e" },
      ".cm-changed-line-modified": { backgroundColor: "#0969da" },
      ".cm-changed-line-deleted": { backgroundColor: "#cf222e" },
    }),
  ];
}

/** The editor's view of a baseline: the gutter bars, or the inline diff, whose chunk controls (when
 *  `onAcceptChunk` is given) stage a chunk: accepting one applies it to the merge view's original
 *  doc, which this reports whole. */
function baselineExtensions(
  cm: CodeMirror,
  input: {
    baseline: string;
    diff: boolean;
    onAcceptChunk: ((baseline: string) => void) | undefined;
  },
): Extension {
  if (!input.diff) return changedLinesGutter(cm, input.baseline);
  const { EditorView } = cm.view;
  const { onAcceptChunk } = input;
  return [
    cm.merge.unifiedMergeView({
      original: input.baseline,
      allowInlineDiffs: true,
      mergeControls: onAcceptChunk
        ? (type, action) => {
            const button = document.createElement("button");
            button.textContent = type === "accept" ? "+" : "⨯";
            button.title = type === "accept" ? "Stage block" : "Discard block";
            button.onmousedown = action;
            return button;
          }
        : false,
    }),
    onAcceptChunk
      ? EditorView.updateListener.of((update) => {
          const original = cm.merge.getOriginalDoc(update.state);
          if (original.eq(cm.merge.getOriginalDoc(update.startState))) return;
          onAcceptChunk(original.toString());
        })
      : [],
    EditorView.baseTheme({
      ".cm-chunkButtons button": {
        cursor: "pointer",
        border: "1px solid #d0d7de",
        borderRadius: "3px",
        background: "#fff",
        margin: "0 1px",
        padding: "0 5px",
        fontSize: "11px",
        lineHeight: "16px",
      },
    }),
  ];
}

export function editorExtensions(
  cm: CodeMirror,
  input: {
    language: RepoFileLanguage;
    readOnly: boolean;
    label: string;
    baseline: string | undefined;
    diff: boolean;
    onAcceptChunk: ((baseline: string) => void) | undefined;
    onChange: (value: string) => void;
  },
): Extension[] {
  const { EditorView } = cm.view;
  return [
    cm.basicSetup,
    cm.vsCodeLight,
    cm.languageSupport,
    cm.state.EditorState.readOnly.of(input.readOnly),
    EditorView.editable.of(!input.readOnly),
    // the editor's accessible name: its content is the textbox
    EditorView.contentAttributes.of({ "aria-label": input.label }),
    // prose wraps; code scrolls
    input.language === "markdown" ? EditorView.lineWrapping : [],
    EditorView.updateListener.of((update) => {
      if (update.docChanged) input.onChange(update.state.doc.toString());
    }),
    EditorView.theme({
      "&": { height: "100%", fontSize: "12px" },
      "&.cm-focused": { outline: "none" },
      ".cm-scroller": { overflow: "auto", fontFamily: "var(--font-mono, monospace)" },
      ".cm-activeLine, .cm-activeLineGutter": { backgroundColor: "transparent" },
    }),
    // a baseline of "" is an empty file, a missing one is no baseline at all
    // oxlint-disable-next-line iterate/simple-truthiness-check -- "" is a baseline, undefined is none
    input.baseline === undefined
      ? []
      : baselineExtensions(cm, {
          baseline: input.baseline,
          diff: input.diff,
          onAcceptChunk: input.onAcceptChunk,
        }),
  ];
}
