// The doc editor: CodeMirror over the file's markdown with Atomic's Obsidian-style live preview
// (@atomic-editor/editor, assembled as its own AtomicCodeMirrorEditor component does). Rich and
// Markdown mode are the same editor with the preview in or out of `preview`, so the text, the
// selection and the undo history carry across a switch. Undo is Yjs's (doc-session.ts): it undoes
// this person's edits and leaves everyone else's.
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
import { ATOMIC_CODE_LANGUAGES } from "@atomic-editor/editor/code-languages";
import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { defaultKeymap, indentWithTab } from "@codemirror/commands";
import { markdown, markdownKeymap, markdownLanguage } from "@codemirror/lang-markdown";
import { bracketMatching, indentOnInput, LanguageDescription } from "@codemirror/language";
import { Compartment, EditorState, Prec, type Extension } from "@codemirror/state";
import {
  drawSelection,
  dropCursor,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  rectangularSelection,
} from "@codemirror/view";
import { promptLink, toggleWrap } from "./commands.ts";
import { frontmatterProperties } from "./frontmatter.ts";

/** A markdown file's two views of one editor, Rich (the live preview) and Markdown. */
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

/** Atomic's colours from the app's theme (packages/ui globals.css), which is light only: Atomic's
 *  own defaults are a dark theme, inline code and code blocks' syntax colours included (the `hl-`
 *  ones, GitHub's light palette here; a fence's language name is `hl-variable`). */
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
    "--atomic-editor-hl-comment": "#6a737d",
    "--atomic-editor-hl-escape": "#005cc5",
    "--atomic-editor-hl-function": "#6f42c1",
    "--atomic-editor-hl-invalid": "#cb2431",
    "--atomic-editor-hl-keyword": "#d73a49",
    "--atomic-editor-hl-number": "#005cc5",
    "--atomic-editor-hl-operator": "#d73a49",
    "--atomic-editor-hl-property": "#005cc5",
    "--atomic-editor-hl-regexp": "#032f62",
    "--atomic-editor-hl-string": "#032f62",
    "--atomic-editor-hl-tag": "#22863a",
    "--atomic-editor-hl-type": "#e36209",
    "--atomic-editor-hl-variable": "var(--foreground)",
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
}): Extension {
  return [
    highlightSpecialChars(),
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
    // code blocks highlight in their fence's language, each grammar fetched when a doc first uses it
    markdown({
      base: markdownLanguage,
      codeLanguages: ATOMIC_CODE_LANGUAGES,
      extensions: highlightMarkdown,
    }),
    atomicMarkdownSyntax,
    atomicEditorTheme,
    theme,
    formattingKeymap,
    // Tab indents the line, which nests a list item, and the editor keeps focus (indentWithTab):
    // Escape then Tab moves focus on, as CodeMirror's docs on trapping Tab describe.
    keymap.of([...closeBracketsKeymap, ...markdownKeymap, indentWithTab, ...defaultKeymap]),
    options.preview.of(previewExtensions(options.mode)),
  ];
}

/** Any other text file: a code editor, highlighted in its language once `language` holds it
 *  (`codeLanguage`), in Atomic's syntax colours (`theme` above). */
export function codeEditorExtensions(options: { language: Extension }): Extension {
  return [
    lineNumbers(),
    highlightActiveLineGutter(),
    highlightSpecialChars(),
    drawSelection(),
    dropCursor(),
    EditorState.allowMultipleSelections.of(true),
    indentOnInput(),
    bracketMatching(),
    closeBrackets(),
    rectangularSelection(),
    highlightActiveLine(),
    // Atomic's highlight style (its name says markdown; its tags are every language's)
    atomicMarkdownSyntax,
    atomicEditorTheme,
    theme,
    // over Atomic's theme, which hides the gutters
    Prec.highest(codeTheme),
    keymap.of([...closeBracketsKeymap, indentWithTab, ...defaultKeymap]),
    options.language,
  ];
}

/** Code reads as code: monospace, the whole width, no page margins. */
const codeTheme = EditorView.theme({
  ".cm-content": {
    fontFamily: "var(--font-mono, ui-monospace, monospace)",
    fontSize: "13px",
    maxWidth: "none",
  },
  ".cm-line": { lineHeight: "1.55" },
  ".cm-activeLineGutter": { backgroundColor: "var(--muted)", color: "var(--foreground)" },
  // Atomic hides the gutters (a document has none); a code file's line numbers are shown
  ".cm-gutters": {
    display: "flex",
    backgroundColor: "var(--background)",
    color: "var(--muted-foreground)",
    border: "none",
  },
});

/** The language a file is written in, by its name, from the same list code blocks use; none for
 *  a name no language claims. Each grammar is fetched the first time it's needed. */
export async function codeLanguage(path: string): Promise<Extension> {
  const description = LanguageDescription.matchFilename(ATOMIC_CODE_LANGUAGES, path);
  return description ? await description.load() : [];
}
