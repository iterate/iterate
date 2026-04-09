"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Check, Copy, Terminal } from "lucide-react";
import { basicSetup, EditorView } from "codemirror";
import { json } from "@codemirror/lang-json";
import { yaml } from "@codemirror/lang-yaml";
import { foldService } from "@codemirror/language";
import { search, searchKeymap } from "@codemirror/search";
import { keymap } from "@codemirror/view";
import { vsCodeDark, vsCodeLight } from "@fsegurai/codemirror-theme-bundle";
import { useTheme } from "next-themes";
import { toast } from "sonner";
import { stringify as stringifyYaml } from "yaml";
import { Tooltip, TooltipContent, TooltipTrigger } from "@iterate-com/ui/components/tooltip";
import { cn } from "@iterate-com/ui/lib/utils";

type SerializedFormat = "yaml" | "json";

interface CodeMirrorProps {
  value: string;
  extensions: NonNullable<ConstructorParameters<typeof EditorView>[0]>["extensions"];
}

function CodeMirror({ value, extensions }: CodeMirrorProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);

  useEffect(() => {
    if (!containerRef.current) {
      return;
    }

    viewRef.current?.destroy();

    const view = new EditorView({
      doc: value,
      extensions,
      parent: containerRef.current,
    });

    viewRef.current = view;

    return () => {
      viewRef.current?.destroy();
      viewRef.current = null;
    };
  }, [extensions, value]);

  return <div ref={containerRef} />;
}

export interface SerializedObjectCodeBlockProps {
  data: unknown;
  className?: string;
  initialFormat?: SerializedFormat;
  showToggle?: boolean;
  showCopyButton?: boolean;
  showDebugConsoleButton?: boolean;
  scrollToBottom?: boolean;
  showLineNumbers?: boolean;
}

export function SerializedObjectCodeBlock({
  data,
  className,
  initialFormat = "yaml",
  showToggle = true,
  showCopyButton = true,
  showDebugConsoleButton = false,
  scrollToBottom = false,
  showLineNumbers = true,
}: SerializedObjectCodeBlockProps) {
  const [currentFormat, setCurrentFormat] = useState<SerializedFormat>(initialFormat);
  const [copiedFormat, setCopiedFormat] = useState<SerializedFormat | null>(null);
  const { resolvedTheme } = useTheme();
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  const code = useMemo(() => serializeData(data, currentFormat), [currentFormat, data]);

  const extensions = useMemo<CodeMirrorProps["extensions"]>(
    () => [
      basicSetup,
      resolvedTheme === "dark" ? vsCodeDark : vsCodeLight,
      (currentFormat === "yaml" ? yaml : json)(),
      search({ top: true }),
      foldPromptBlocks(),
      keymap.of(searchKeymap),
      EditorView.editable.of(false),
      EditorView.contentAttributes.of({ tabindex: "0" }),
      EditorView.lineWrapping,
      !showLineNumbers
        ? EditorView.theme({
            ".cm-gutters": {
              display: "none",
            },
          })
        : [],
    ],
    [currentFormat, resolvedTheme, showLineNumbers],
  );

  const handleCopy = async (format: SerializedFormat) => {
    try {
      await navigator.clipboard.writeText(serializeData(data, format));
      setCopiedFormat(format);
      window.setTimeout(() => {
        setCopiedFormat((value) => (value === format ? null : value));
      }, 2_000);
      toast.success(`${format.toUpperCase()} copied to clipboard`);
    } catch {
      toast.error(`Failed to copy ${format.toUpperCase()} to clipboard`);
    }
  };

  useEffect(() => {
    if (!scrollToBottom) {
      return;
    }

    const frame = window.requestAnimationFrame(() => {
      const scrollContainer = scrollContainerRef.current;
      if (scrollContainer == null) {
        return;
      }

      scrollContainer.scrollTop = scrollContainer.scrollHeight;
    });

    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [code, scrollToBottom]);

  return (
    <div className={cn("relative flex min-h-0 flex-col", className)}>
      <div
        ref={scrollContainerRef}
        className="cm-SerializedObjectCodeBlock min-h-0 flex-1 overflow-hidden overflow-y-auto rounded border"
      >
        <CodeMirror value={code} extensions={extensions} />
      </div>

      {showToggle || showCopyButton || showDebugConsoleButton ? (
        <div className="absolute top-1 right-1 flex items-center gap-0.5 rounded bg-background px-1 py-0.5 text-xs opacity-40 transition-opacity hover:opacity-90">
          {showToggle ? (
            <button
              type="button"
              onClick={() => setCurrentFormat((value) => (value === "yaml" ? "json" : "yaml"))}
              className="rounded px-1.5 py-0.5 text-xs font-medium hover:bg-muted"
            >
              {currentFormat === "yaml" ? "YAML" : "JSON"}
            </button>
          ) : null}

          {showCopyButton ? (
            <>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <button
                      type="button"
                      onClick={() => void handleCopy("yaml")}
                      className="flex h-3 w-3 items-center justify-center rounded"
                    />
                  }
                >
                  {copiedFormat === "yaml" ? (
                    <Check className="h-2 w-2 text-green-500" />
                  ) : (
                    <Copy className="h-2 w-2" />
                  )}
                </TooltipTrigger>
                <TooltipContent>
                  <p>Copy YAML</p>
                </TooltipContent>
              </Tooltip>

              <Tooltip>
                <TooltipTrigger
                  render={
                    <button
                      type="button"
                      onClick={() => void handleCopy("json")}
                      className="flex h-3 w-3 items-center justify-center rounded"
                    />
                  }
                >
                  {copiedFormat === "json" ? (
                    <Check className="h-2 w-2 text-green-500" />
                  ) : (
                    <Copy className="h-2 w-2" />
                  )}
                </TooltipTrigger>
                <TooltipContent>
                  <p>Copy JSON</p>
                </TooltipContent>
              </Tooltip>
            </>
          ) : null}

          {showDebugConsoleButton ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    onClick={() => {
                      (window as { thing?: unknown }).thing = data;
                      toast.success(
                        "Object printed to browser console and assigned to window.thing",
                      );
                    }}
                    className="flex h-3 w-3 items-center justify-center rounded"
                  />
                }
              >
                <Terminal className="h-2 w-2" />
              </TooltipTrigger>
              <TooltipContent>
                <p>Print to browser console and assign to `window.thing`</p>
              </TooltipContent>
            </Tooltip>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function serializeData(data: unknown, format: SerializedFormat) {
  try {
    if (data === undefined) {
      return format === "yaml" ? "undefined" : '"undefined"';
    }

    if (data === null) {
      return "null";
    }

    return format === "yaml" ? stringifyYaml(data) : JSON.stringify(data, null, 2);
  } catch (error) {
    return format === "yaml"
      ? `# Error serializing data\n# ${error instanceof Error ? error.message : "Unknown error"}`
      : JSON.stringify(
          {
            error: "Failed to serialize data",
            message: error instanceof Error ? error.message : "Unknown error",
          },
          null,
          2,
        );
  }
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

    if (line.text.endsWith("/**")) {
      for (let i = line.number + 1; i <= state.doc.lines; i++) {
        const nextLine = state.doc.line(i);
        if (nextLine.text.includes("*/")) {
          return collapseTo(nextLine);
        }
      }
    }

    for (const pair of ["{}", "[]"] as const) {
      if (line.text.trimEnd().endsWith(pair[0])) {
        const indent = line.text.match(/^\s*/)?.[0] || "";
        for (let i = line.number + 1; i <= state.doc.lines; i++) {
          const nextLine = state.doc.line(i);
          if (nextLine.text === indent + pair[1]) {
            return collapseTo(nextLine);
          }
        }
      }
    }

    return null;
  });
}
