"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";
import { basicSetup, EditorView } from "codemirror";
import { json } from "@codemirror/lang-json";
import { json5 } from "codemirror-json5";
import { javascript } from "@codemirror/lang-javascript";
import { yaml } from "@codemirror/lang-yaml";
import { markdown } from "@codemirror/lang-markdown";
import { html } from "@codemirror/lang-html";
import { sql } from "@codemirror/lang-sql";
import { foldService } from "@codemirror/language";
import { search, searchKeymap } from "@codemirror/search";
import { keymap } from "@codemirror/view";
import { vsCodeLight } from "@fsegurai/codemirror-theme-bundle";
import { toast } from "sonner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@iterate-com/ui/components/tooltip";
import { cn } from "@iterate-com/ui/lib/utils";

export type SourceCodeBlockExtension = Exclude<
  NonNullable<ConstructorParameters<typeof EditorView>[0]>["extensions"],
  undefined
>;

interface CodeMirrorProps {
  value: string;
  extensions: readonly SourceCodeBlockExtension[];
  editable: boolean;
  selectAllSignal?: number;
  onChange?: (value: string) => void;
  onModEnter?: () => void;
}

function CodeMirror({
  value,
  extensions,
  editable,
  selectAllSignal,
  onChange,
  onModEnter,
}: CodeMirrorProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  // Handoff between the rebuild effect's cleanup (which destroys the old
  // view) and the next effect body (which restores into the new one).
  const preservedViewStateRef = useRef<{ state: EditorView["state"]; hadFocus: boolean } | null>(
    null,
  );
  const onChangeRef = useRef(onChange);
  const onModEnterRef = useRef(onModEnter);
  const initialSelectAllSignalRef = useRef(selectAllSignal);
  const selectAllSignalRef = useRef(selectAllSignal);
  const latestSelectAllSignalRef = useRef(selectAllSignal);
  const valueRef = useRef(value);
  const syncingValueRef = useRef(false);
  valueRef.current = value;
  latestSelectAllSignalRef.current = selectAllSignal;

  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  useEffect(() => {
    onModEnterRef.current = onModEnter;
  }, [onModEnter]);

  useEffect(() => {
    if (!containerRef.current) return;
    // Extension changes (e.g. a lint schema arriving, diff mode toggling)
    // rebuild the whole view. The previous effect's CLEANUP has already
    // destroyed it by the time this body runs, so restoration state comes
    // from the stash the cleanup left behind — carrying selection and focus
    // over so a rebuild mid-edit doesn't dump the user's cursor (or send
    // their keystrokes to <body>).
    const preserved = preservedViewStateRef.current;
    preservedViewStateRef.current = null;
    viewRef.current?.destroy();

    const view = new EditorView({
      doc: valueRef.current,
      extensions: [
        keymap.of([
          {
            key: "Mod-Enter",
            run: () => {
              onModEnterRef.current?.();
              return !!onModEnterRef.current;
            },
          },
          {
            key: "Shift-Enter",
            run: () => {
              onModEnterRef.current?.();
              return !!onModEnterRef.current;
            },
          },
        ]),
        extensions,
        EditorView.editable.of(editable),
        EditorView.updateListener.of((update) => {
          if (!update.docChanged || syncingValueRef.current) {
            return;
          }

          onChangeRef.current?.(update.state.doc.toString());
        }),
      ],
      parent: containerRef.current,
    });

    viewRef.current = view;
    if (preserved !== null && preserved.state.doc.eq(view.state.doc)) {
      view.dispatch({ selection: preserved.state.selection, scrollIntoView: true });
      if (preserved.hadFocus) view.focus();
    }
    if (
      latestSelectAllSignalRef.current !== undefined &&
      latestSelectAllSignalRef.current !== initialSelectAllSignalRef.current
    ) {
      selectAll(view);
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (!editable || event.key !== "Tab" || event.metaKey || event.ctrlKey || event.altKey) {
        return;
      }

      event.preventDefault();

      const selection = view.state.selection.main;
      const indent = "\t";

      view.dispatch({
        changes: {
          from: selection.from,
          to: selection.to,
          insert: indent,
        },
        selection: {
          anchor: selection.from + indent.length,
        },
      });
    };

    view.dom.addEventListener("keydown", handleKeyDown);

    return () => {
      view.dom.removeEventListener("keydown", handleKeyDown);
      const current = viewRef.current;
      if (current !== null) {
        // Stash for the rebuild that may immediately follow (see above).
        preservedViewStateRef.current = { state: current.state, hadFocus: current.hasFocus };
      }
      current?.destroy();
      viewRef.current = null;
    };
  }, [editable, extensions]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) {
      return;
    }

    const currentValue = view.state.doc.toString();
    if (currentValue === value) {
      return;
    }

    syncingValueRef.current = true;
    try {
      view.dispatch({
        changes: {
          from: 0,
          to: currentValue.length,
          insert: value,
        },
      });
    } finally {
      syncingValueRef.current = false;
    }
  }, [value]);

  useEffect(() => {
    if (selectAllSignal === undefined || selectAllSignal === selectAllSignalRef.current) {
      return;
    }
    selectAllSignalRef.current = selectAllSignal;

    const view = viewRef.current;
    if (!view) {
      return;
    }

    selectAll(view);
  }, [selectAllSignal]);

  return <div ref={containerRef} />;
}

function selectAll(view: EditorView) {
  view.focus();
  view.dispatch({
    selection: {
      anchor: 0,
      head: view.state.doc.length,
    },
  });
}

export type SourceCodeLanguage =
  | "typescript"
  | "javascript"
  | "json"
  | "jsonc"
  | "yaml"
  | "markdown"
  | "html"
  | "sql"
  | "text";

/** The CodeMirror language extension for a {@link SourceCodeLanguage}. */
export function sourceCodeLanguageExtension(
  language: SourceCodeLanguage,
): SourceCodeBlockExtension {
  switch (language) {
    case "typescript":
      return javascript({ jsx: true, typescript: true });
    case "javascript":
      return javascript({ jsx: true });
    case "json":
      return json();
    case "jsonc":
      // JSON-with-comments (tsconfig & friends). The json5 grammar is a
      // superset of jsonc, so comments and trailing commas parse cleanly;
      // strict parse linting stays a caller concern, as with every language.
      return json5();
    case "yaml":
      return yaml();
    case "markdown":
      return markdown();
    case "html":
      return html();
    case "sql":
      return sql();
    case "text":
      return [];
  }
}

export interface SourceCodeBlockProps {
  code: string;
  className?: string;
  language?: SourceCodeLanguage;
  showCopyButton?: boolean;
  showLineNumbers?: boolean;
  /** Keep the fold gutter when line numbers are hidden. */
  showFoldGutter?: boolean;
  plainChrome?: boolean;
  wrapLongLines?: boolean;
  editable?: boolean;
  codeMirrorExtensions?: readonly SourceCodeBlockExtension[];
  selectAllSignal?: number;
  onChange?: (value: string) => void;
  onModEnter?: () => void;
}

export function SourceCodeBlock({
  code,
  className,
  language = "typescript",
  showCopyButton = true,
  showLineNumbers = true,
  showFoldGutter = false,
  plainChrome = false,
  wrapLongLines = true,
  editable = false,
  codeMirrorExtensions,
  selectAllSignal,
  onChange,
  onModEnter,
}: SourceCodeBlockProps) {
  const [copied, setCopied] = useState(false);

  const extensions = useMemo<CodeMirrorProps["extensions"]>(() => {
    const languageExtension = sourceCodeLanguageExtension(language);

    return [
      basicSetup,
      vsCodeLight,
      languageExtension,
      search({ top: true }),
      foldPromptBlocks(),
      keymap.of(searchKeymap),
      EditorView.contentAttributes.of({ tabindex: "0" }),
      wrapLongLines ? EditorView.lineWrapping : [],
      // Orthogonal on purpose: plainChrome strips the visual chrome (border,
      // highlights), showLineNumbers alone decides the gutter —
      // showFoldGutter keeps just the fold arrows when line numbers are off
      // (collapsible YAML/JSON sections without the number column).
      !showLineNumbers
        ? EditorView.theme(
            showFoldGutter
              ? { ".cm-gutter.cm-lineNumbers": { display: "none" } }
              : { ".cm-gutters": { display: "none" } },
          )
        : [],
      plainChrome
        ? EditorView.theme({
            ".cm-activeLine, .cm-activeLineGutter, .cm-selectionMatch": {
              backgroundColor: "transparent",
            },
            ".cm-focused": {
              outline: "none",
            },
          })
        : [],
      codeMirrorExtensions ?? [],
    ];
  }, [codeMirrorExtensions, language, plainChrome, showFoldGutter, showLineNumbers, wrapLongLines]);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2_000);
      toast.success("Copied to clipboard");
    } catch {
      toast.error("Failed to copy");
    }
  };

  return (
    <div className={cn("relative flex min-h-0 flex-col", className)}>
      <div
        className={cn(
          "min-h-0 flex-1 overflow-hidden overflow-y-auto",
          plainChrome ? "" : "rounded border",
        )}
      >
        <CodeMirror
          value={code}
          extensions={extensions}
          editable={editable}
          selectAllSignal={selectAllSignal}
          onChange={onChange}
          onModEnter={onModEnter}
        />
      </div>

      {showCopyButton ? (
        <div className="absolute top-1 right-1 flex items-center gap-0.5 rounded bg-background px-1 py-0.5 text-xs opacity-40 transition-opacity hover:opacity-90">
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  onClick={() => void handleCopy()}
                  className="flex h-3 w-3 items-center justify-center rounded"
                />
              }
            >
              {copied ? <Check className="h-2 w-2 text-green-500" /> : <Copy className="h-2 w-2" />}
            </TooltipTrigger>
            <TooltipContent>
              <p>Copy code</p>
            </TooltipContent>
          </Tooltip>
        </div>
      ) : null}
    </div>
  );
}

function foldPromptBlocks() {
  return foldService.of((state, lineStart, lineEnd) => {
    const line = state.doc.lineAt(lineStart);

    const collapseTo = (otherLine: typeof line) => {
      const indent = otherLine.text.split(/\S/)[0];
      return { from: lineEnd, to: otherLine.from + indent.length };
    };

    if (line.text.match(/^\s*<\S+>$/)) {
      const closeTag = line.text.replace("<", "</");
      for (let i = line.number + 1; i <= state.doc.lines; i++) {
        const nextLine = state.doc.line(i);
        if (nextLine.text === closeTag) {
          return collapseTo(nextLine);
        }
      }
    }

    if (line.text.match(/^\s*```\w*\s*$/)) {
      const closeTag = line.text.slice(0, line.text.lastIndexOf("`") + 1);
      for (let i = line.number + 1; i <= state.doc.lines; i++) {
        const nextLine = state.doc.line(i);
        if (nextLine.text === closeTag) {
          return collapseTo(nextLine);
        }
      }
    }

    const markdownHeadingRegex = /^\s*#+ \w/;
    if (markdownHeadingRegex.test(line.text)) {
      const startIndent = line.text.match(/^\s*/)?.[0] || "";
      for (let i = line.number + 1; i <= state.doc.lines; i++) {
        const { text } = state.doc.line(i);
        const lessIndentedThanStart = text.trim() && !text.startsWith(startIndent);
        if (markdownHeadingRegex.test(text) || lessIndentedThanStart || i === state.doc.lines) {
          return { from: lineEnd, to: state.doc.line(i - 1).from - 1 };
        }
      }
    }

    return null;
  });
}
