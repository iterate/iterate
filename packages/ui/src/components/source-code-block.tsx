"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";
import { basicSetup, EditorView } from "codemirror";
import { json } from "@codemirror/lang-json";
import { javascript } from "@codemirror/lang-javascript";
import { foldService } from "@codemirror/language";
import { search, searchKeymap } from "@codemirror/search";
import { keymap } from "@codemirror/view";
import { vsCodeDark, vsCodeLight } from "@fsegurai/codemirror-theme-bundle";
import { useTheme } from "next-themes";
import { toast } from "sonner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@iterate-com/ui/components/tooltip";
import { cn } from "@iterate-com/ui/lib/utils";

type SourceCodeLanguage = "typescript" | "json" | "text";
type EditorExtensions = Exclude<
  NonNullable<ConstructorParameters<typeof EditorView>[0]>["extensions"],
  undefined
>;

interface CodeMirrorProps {
  value: string;
  extensions: readonly EditorExtensions[];
  editable: boolean;
  onChange?: (value: string) => void;
}

function CodeMirror({ value, extensions, editable, onChange }: CodeMirrorProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  const initialValueRef = useRef(value);

  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  useEffect(() => {
    if (!containerRef.current) {
      return;
    }

    viewRef.current?.destroy();

    const view = new EditorView({
      doc: initialValueRef.current,
      extensions: [
        extensions,
        EditorView.editable.of(editable),
        EditorView.updateListener.of((update) => {
          if (!update.docChanged) {
            return;
          }

          onChangeRef.current?.(update.state.doc.toString());
        }),
      ],
      parent: containerRef.current,
    });

    viewRef.current = view;

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
      viewRef.current?.destroy();
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

    view.dispatch({
      changes: {
        from: 0,
        to: currentValue.length,
        insert: value,
      },
    });
  }, [value]);

  return <div ref={containerRef} />;
}

export interface SourceCodeBlockProps {
  code: string;
  className?: string;
  language?: SourceCodeLanguage;
  showCopyButton?: boolean;
  wrapLongLines?: boolean;
  editable?: boolean;
  onChange?: (value: string) => void;
}

export function SourceCodeBlock({
  code,
  className,
  language = "typescript",
  showCopyButton = true,
  wrapLongLines = true,
  editable = false,
  onChange,
}: SourceCodeBlockProps) {
  const [copied, setCopied] = useState(false);
  const { resolvedTheme } = useTheme();

  const extensions = useMemo<CodeMirrorProps["extensions"]>(() => {
    const languageExtension =
      language === "json"
        ? json()
        : language === "typescript"
          ? javascript({ typescript: true })
          : [];

    return [
      basicSetup,
      resolvedTheme === "dark" ? vsCodeDark : vsCodeLight,
      languageExtension,
      search({ top: true }),
      foldPromptBlocks(),
      keymap.of(searchKeymap),
      EditorView.contentAttributes.of({ tabindex: "0" }),
      wrapLongLines ? EditorView.lineWrapping : [],
    ];
  }, [language, resolvedTheme, wrapLongLines]);

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
      <div className="min-h-0 flex-1 overflow-hidden overflow-y-auto rounded border">
        <CodeMirror value={code} extensions={extensions} editable={editable} onChange={onChange} />
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
