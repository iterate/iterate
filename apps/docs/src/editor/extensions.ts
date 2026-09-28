// The doc editor: CodeMirror over the file's markdown with Atomic's Obsidian-style live preview
// (@atomic-editor/editor, assembled as its own AtomicCodeMirrorEditor component does). Rich and
// Markdown mode are the same editor with the preview in or out of `preview`, so the text, the
// selection and the undo history carry across a switch.
import "@atomic-editor/editor/styles.css";
import {
  atomicEditorTheme,
  atomicMarkdownSyntax,
  autoCloseCodeFence,
  extendEmphasisPair,
  highlightMarkdown,
  imageBlocks,
  inlinePreview,
  startAsteriskList,
  tables,
} from "@atomic-editor/editor";
import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { markdown, markdownKeymap, markdownLanguage } from "@codemirror/lang-markdown";
import { indentOnInput } from "@codemirror/language";
import { Compartment, EditorState, Prec, type Extension } from "@codemirror/state";
import {
  drawSelection,
  dropCursor,
  EditorView,
  highlightActiveLine,
  highlightSpecialChars,
  keymap,
  rectangularSelection,
} from "@codemirror/view";
import { promptLink, toggleWrap } from "./commands.ts";
import { frontmatterProperties } from "./frontmatter.ts";

export type EditorMode = "rich" | "markdown";

/** The live preview: what Markdown mode takes out. */
export function previewExtensions(mode: EditorMode): Extension {
  return mode === "rich" ? [frontmatterProperties, tables(), imageBlocks(), inlinePreview()] : [];
}

/** Formatting shortcuts. `stopPropagation`: the app shell's sidebar toggles on Cmd/Ctrl-B from a
 *  window listener, which a handled key must not reach. */
const formattingKeymap = Prec.highest(
  keymap.of(
    [
      { key: "Mod-b", run: (view: EditorView) => toggleWrap(view, "**") },
      { key: "Mod-i", run: (view: EditorView) => toggleWrap(view, "_") },
      { key: "Mod-e", run: (view: EditorView) => toggleWrap(view, "`") },
      { key: "Mod-Shift-x", run: (view: EditorView) => toggleWrap(view, "~~") },
      { key: "Mod-k", run: promptLink },
    ].map((binding) => ({ ...binding, preventDefault: true, stopPropagation: true })),
  ),
);

/** Atomic's colours from the app's theme (packages/ui globals.css): Atomic's own defaults are a
 *  dark theme, inline code included. */
const theme = EditorView.theme({
  "&": {
    "--atomic-editor-fg": "var(--foreground)",
    "--atomic-editor-fg-muted": "var(--muted-foreground)",
    "--atomic-editor-fg-faint": "var(--muted-foreground)",
    "--atomic-editor-bg": "var(--background)",
    "--atomic-editor-bg-surface": "var(--popover)",
    "--atomic-editor-bg-panel": "var(--muted)",
    "--atomic-editor-border": "var(--border)",
    "--atomic-editor-accent": "var(--primary)",
    "--atomic-editor-accent-bright": "var(--foreground)",
    "--atomic-editor-accent-soft": "var(--accent)",
    "--atomic-editor-link": "var(--primary)",
    "--atomic-editor-link-hover": "var(--foreground)",
    "--atomic-editor-code-bg": "var(--muted)",
    "--atomic-editor-selection-bg": "var(--accent)",
    "--atomic-editor-font": "var(--font-sans, system-ui)",
    "--atomic-editor-measure": "100%",
    fontSize: "15px",
  },
  "&.cm-focused": { outline: "none" },
  ".cm-content": { padding: "8px 0 30vh" },
  ".cm-line": { lineHeight: "1.7" },
});

/** Everything but the preview, which `preview` holds so a mode switch can swap it. */
export function docEditorExtensions(options: {
  mode: EditorMode;
  preview: Compartment;
  onDocChanged: (text: string) => void;
}): Extension {
  return [
    highlightSpecialChars(),
    history(),
    drawSelection(),
    dropCursor(),
    EditorState.allowMultipleSelections.of(true),
    indentOnInput(),
    rectangularSelection(),
    highlightActiveLine(),
    closeBrackets(),
    startAsteriskList,
    extendEmphasisPair,
    autoCloseCodeFence,
    EditorView.lineWrapping,
    markdown({ base: markdownLanguage, extensions: highlightMarkdown }),
    atomicMarkdownSyntax,
    atomicEditorTheme,
    theme,
    formattingKeymap,
    // Tab indents the line, which nests a list item, and the editor keeps focus (indentWithTab):
    // Escape then Tab moves focus on, as CodeMirror's docs on trapping Tab describe.
    keymap.of([
      ...closeBracketsKeymap,
      ...historyKeymap,
      ...markdownKeymap,
      indentWithTab,
      ...defaultKeymap,
    ]),
    options.preview.of(previewExtensions(options.mode)),
    EditorView.updateListener.of((update) => {
      if (update.docChanged) options.onDocChanged(update.state.doc.toString());
    }),
  ];
}
