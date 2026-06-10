"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Check, Copy, Terminal } from "lucide-react";
import { toast } from "sonner";
import { stringify as stringifyYaml } from "yaml";
import { Tooltip, TooltipContent, TooltipTrigger } from "@iterate-com/ui/components/tooltip";
import { cn } from "@iterate-com/ui/lib/utils";

type SerializedFormat = "yaml" | "json";
const loadCodeMirrorModules = import.meta.env.SSR
  ? null
  : async () =>
      Promise.all([
        import("codemirror"),
        import("@codemirror/lang-json"),
        import("@codemirror/lang-yaml"),
        import("@codemirror/language"),
        import("@codemirror/search"),
        import("@codemirror/view"),
        import("@fsegurai/codemirror-theme-bundle"),
      ]);

interface CodeMirrorProps {
  value: string;
  currentFormat: SerializedFormat;
  showLineNumbers: boolean;
  plainChrome: boolean;
}

function CodeMirror({ value, currentFormat, showLineNumbers, plainChrome }: CodeMirrorProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<any>(null);

  useEffect(() => {
    const loader = loadCodeMirrorModules;
    if (!containerRef.current || !loader) return;
    let disposed = false;

    async function mountEditor() {
      const [
        codeMirrorModule,
        jsonModule,
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
      const extensions = [
        basicSetup,
        themeModule.vsCodeLight,
        (currentFormat === "yaml" ? yamlModule.yaml : jsonModule.json)(),
        searchModule.search({ top: true }),
        createFoldPromptBlocks(languageModule.foldService),
        keymap.of(searchModule.searchKeymap),
        EditorView.editable.of(false),
        EditorView.contentAttributes.of({ tabindex: "0" }),
        EditorView.lineWrapping,
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
      ];

      const view = new EditorView({
        doc: value,
        extensions,
        parent: containerRef.current,
      });

      viewRef.current = view;
    }

    void mountEditor();

    return () => {
      disposed = true;
      viewRef.current?.destroy();
      viewRef.current = null;
    };
  }, [currentFormat, plainChrome, showLineNumbers, value]);

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
  plainChrome?: boolean;
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
  plainChrome = false,
}: SerializedObjectCodeBlockProps) {
  const [currentFormat, setCurrentFormat] = useState<SerializedFormat>(initialFormat);
  const [copiedFormat, setCopiedFormat] = useState<SerializedFormat | null>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  const code = useMemo(() => serializeData(data, currentFormat), [currentFormat, data]);

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
        className={cn(
          "cm-SerializedObjectCodeBlock min-h-0 flex-1 overflow-hidden overflow-y-auto",
          plainChrome ? "" : "rounded border",
        )}
      >
        <CodeMirror
          value={code}
          currentFormat={currentFormat}
          showLineNumbers={showLineNumbers}
          plainChrome={plainChrome}
        />
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
