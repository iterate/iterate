"use client";

import { useEffect, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";
import { toast } from "sonner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@iterate-com/ui/components/tooltip";
import { cn } from "@iterate-com/ui/lib/utils";

type SourceCodeLanguage = "typescript" | "json" | "yaml" | "text";
export type SourceCodeBlockExtension = unknown;
const loadCodeMirrorModules = import.meta.env.SSR
  ? null
  : async () =>
      Promise.all([
        import("codemirror"),
        import("@codemirror/lang-json"),
        import("@codemirror/lang-javascript"),
        import("@codemirror/lang-yaml"),
        import("@codemirror/language"),
        import("@codemirror/search"),
        import("@codemirror/view"),
        import("@fsegurai/codemirror-theme-bundle"),
      ]);

interface CodeMirrorProps {
  value: string;
  editable: boolean;
  language: SourceCodeLanguage;
  showLineNumbers: boolean;
  plainChrome: boolean;
  wrapLongLines: boolean;
  codeMirrorExtensions?: readonly SourceCodeBlockExtension[];
  selectAllSignal?: number;
  onChange?: (value: string) => void;
  onModEnter?: () => void;
}

function CodeMirror({
  value,
  editable,
  language,
  showLineNumbers,
  plainChrome,
  wrapLongLines,
  codeMirrorExtensions,
  selectAllSignal,
  onChange,
  onModEnter,
}: CodeMirrorProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<any>(null);
  const onChangeRef = useRef(onChange);
  const onModEnterRef = useRef(onModEnter);
  const initialSelectAllSignalRef = useRef(selectAllSignal);
  const selectAllSignalRef = useRef(selectAllSignal);
  const latestSelectAllSignalRef = useRef(selectAllSignal);
  const valueRef = useRef(value);
  valueRef.current = value;
  latestSelectAllSignalRef.current = selectAllSignal;

  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  useEffect(() => {
    onModEnterRef.current = onModEnter;
  }, [onModEnter]);

  useEffect(() => {
    const loader = loadCodeMirrorModules;
    if (!containerRef.current || !loader) return;
    let disposed = false;

    async function mountEditor() {
      const [
        codeMirrorModule,
        jsonModule,
        javascriptModule,
        yamlModule,
        languageModule,
        searchModule,
        viewModule,
        themeModule,
      ] = await loader!();

      if (disposed || !containerRef.current) return;
      viewRef.current?.destroy();

      const { basicSetup, EditorView } = codeMirrorModule;
      const { keymap } = viewModule;
      const languageExtension =
        language === "json"
          ? jsonModule.json()
          : language === "yaml"
            ? yamlModule.yaml()
            : language === "typescript"
              ? javascriptModule.javascript({ typescript: true })
              : [];

      const extensions = [
        basicSetup,
        themeModule.vsCodeLight,
        languageExtension,
        searchModule.search({ top: true }),
        createFoldPromptBlocks(languageModule.foldService),
        keymap.of(searchModule.searchKeymap),
        EditorView.contentAttributes.of({ tabindex: "0" }),
        wrapLongLines ? EditorView.lineWrapping : [],
        !showLineNumbers || plainChrome
          ? EditorView.theme({
              ".cm-gutters": {
                display: "none",
              },
            })
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
          EditorView.updateListener.of((update: any) => {
            if (!update.docChanged) {
              return;
            }

            onChangeRef.current?.(update.state.doc.toString());
          }),
        ],
        parent: containerRef.current,
      });

      viewRef.current = view;
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
    }

    void mountEditor();

    return () => {
      disposed = true;
      viewRef.current?.destroy();
      viewRef.current = null;
    };
  }, [codeMirrorExtensions, editable, language, plainChrome, showLineNumbers, wrapLongLines]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) {
      return;
    }

    const currentValue = view.state.doc.toString();
    if (currentValue === value) {
      return;
    }

    view.dispatch({
      changes: {
        from: 0,
        to: currentValue.length,
        insert: value,
      },
    });
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

function selectAll(view: any) {
  view.focus();
  view.dispatch({
    selection: {
      anchor: 0,
      head: view.state.doc.length,
    },
  });
}

export interface SourceCodeBlockProps {
  code: string;
  className?: string;
  language?: SourceCodeLanguage;
  showCopyButton?: boolean;
  showLineNumbers?: boolean;
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
  plainChrome = false,
  wrapLongLines = true,
  editable = false,
  codeMirrorExtensions,
  selectAllSignal,
  onChange,
  onModEnter,
}: SourceCodeBlockProps) {
  const [copied, setCopied] = useState(false);

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
          editable={editable}
          language={language}
          showLineNumbers={showLineNumbers}
          plainChrome={plainChrome}
          wrapLongLines={wrapLongLines}
          codeMirrorExtensions={codeMirrorExtensions}
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

function createFoldPromptBlocks(foldService: any) {
  return foldService.of((state: any, lineStart: number, lineEnd: number) => {
    const line = state.doc.lineAt(lineStart);

    const collapseTo = (otherLine: any) => {
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
