import { useState, useEffect, useRef } from "react";
import { Check, Copy, Terminal } from "lucide-react";
import { toast } from "sonner";
import { stringify as stringifyYaml } from "yaml";
import { basicSetup, EditorView } from "codemirror";
import { json } from "@codemirror/lang-json";
import { yaml } from "@codemirror/lang-yaml";
import { search, searchKeymap } from "@codemirror/search";
import { keymap } from "@codemirror/view";
import { vsCodeDark, vsCodeLight } from "@fsegurai/codemirror-theme-bundle";
import { useTheme } from "next-themes";
import { foldService } from "@codemirror/language";
import { Switch } from "./ui/switch.tsx";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip.tsx";
import { cn } from "@/lib/utils.ts";

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
  }, [value, extensions]);

  return <div ref={containerRef} />;
}

interface SerializedObjectCodeBlockProps {
  data: unknown;
  className?: string;
  initialFormat?: "yaml" | "json";
  showToggle?: boolean;
  showCopyButton?: boolean;
}

export function SerializedObjectCodeBlock({
  data,
  className,
  initialFormat = "yaml",
  showToggle = true,
  showCopyButton = true,
}: SerializedObjectCodeBlockProps) {
  const [currentFormat, setCurrentFormat] = useState<"yaml" | "json">(initialFormat);
  const { resolvedTheme } = useTheme();

  let code: string;
  try {
    if (data === undefined) {
      code = currentFormat === "yaml" ? "undefined" : '"undefined"';
    } else if (data === null) {
      code = currentFormat === "yaml" ? "null" : "null";
    } else if (currentFormat === "yaml") {
      code = stringifyYaml(data);
    } else {
      code = JSON.stringify(data, null, 2);
    }
  } catch (error) {
    code =
      currentFormat === "yaml"
        ? `# Error serializing data\n# ${error instanceof Error ? error.message : "Unknown error"}`
        : `{\n  "error": "Failed to serialize data",\n  "message": "${error instanceof Error ? error.message : "Unknown error"}"\n}`;
  }

  if (typeof code !== "string") {
    code = String(code || "");
  }

  const [copiedJson, setCopiedJson] = useState(false);
  const [copiedYaml, setCopiedYaml] = useState(false);

  const handleCopyJson = async () => {
    try {
      let jsonCode: string;
      if (data === undefined) {
        jsonCode = '"undefined"';
      } else if (data === null) {
        jsonCode = "null";
      } else {
        jsonCode = JSON.stringify(data, null, 2);
      }
      await navigator.clipboard.writeText(jsonCode);
      setCopiedJson(true);
      setTimeout(() => setCopiedJson(false), 2000);
      toast.success("JSON copied to clipboard");
    } catch {
      toast.error("Failed to copy JSON to clipboard");
    }
  };

  const handleCopyYaml = async () => {
    try {
      let yamlCode: string;
      if (data === undefined) {
        yamlCode = "undefined";
      } else if (data === null) {
        yamlCode = "null";
      } else {
        yamlCode = stringifyYaml(data);
      }
      await navigator.clipboard.writeText(yamlCode);
      setCopiedYaml(true);
      setTimeout(() => setCopiedYaml(false), 2000);
      toast.success("YAML copied to clipboard");
    } catch {
      toast.error("Failed to copy YAML to clipboard");
    }
  };

  const handleToggle = () => {
    setCurrentFormat(currentFormat === "yaml" ? "json" : "yaml");
  };

  const lang = currentFormat === "yaml" ? yaml : json;
  const codeMirrorTheme = resolvedTheme === "dark" ? vsCodeDark : vsCodeLight;
  const extensions: CodeMirrorProps["extensions"] = [
    basicSetup,
    codeMirrorTheme,
    lang(),
    search({ top: true }),
    foldPromptBlocks(),
    keymap.of(searchKeymap),
    EditorView.editable.of(false),
    EditorView.contentAttributes.of({ tabindex: "0" }),
    EditorView.lineWrapping,
  ];

  return (
    <div className={cn("relative flex flex-col", className)}>
      <div className="cm-SerializedObjectCodeBlock rounded overflow-hidden overflow-y-auto flex-1 min-h-0">
        <CodeMirror value={code} extensions={extensions} />
      </div>

      {(showToggle || showCopyButton) && (
        <div className="absolute top-1 right-1 flex items-center gap-0.5 px-1 py-0.5 bg-background rounded text-xs opacity-40 hover:opacity-90 transition-opacity">
          {showToggle && (
            <>
              <span
                className={cn("text-xs", {
                  "text-muted-foreground": currentFormat !== "yaml",
                  "text-foreground": currentFormat === "yaml",
                })}
              >
                YAML
              </span>
              <Switch
                checked={currentFormat === "json"}
                onCheckedChange={handleToggle}
                className="scale-50"
              />
              <span
                className={cn("text-xs", {
                  "text-muted-foreground": currentFormat !== "json",
                  "text-foreground": currentFormat === "json",
                })}
              >
                JSON
              </span>
            </>
          )}

          {showCopyButton && (
            <>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={handleCopyYaml}
                    className="flex items-center justify-center w-3 h-3 rounded"
                    title="Copy as YAML"
                  >
                    {copiedYaml ? (
                      <Check className="w-2 h-2 text-green-500" />
                    ) : (
                      <Copy className="w-2 h-2" />
                    )}
                  </button>
                </TooltipTrigger>
                <TooltipContent>
                  <p>Copy YAML</p>
                </TooltipContent>
              </Tooltip>

              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={handleCopyJson}
                    className="flex items-center justify-center w-3 h-3 rounded"
                    title="Copy as JSON"
                  >
                    {copiedJson ? (
                      <Check className="w-2 h-2 text-green-500" />
                    ) : (
                      <Copy className="w-2 h-2" />
                    )}
                  </button>
                </TooltipTrigger>
                <TooltipContent>
                  <p>Copy JSON</p>
                </TooltipContent>
              </Tooltip>

              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={() => {
                      (window as { thing?: unknown }).thing = data;
                      toast.success(
                        "Object printed to browser console and assigned to window.thing",
                      );
                    }}
                    className="flex items-center justify-center w-3 h-3 rounded"
                  >
                    <Terminal className="w-2 h-2" />
                  </button>
                </TooltipTrigger>
                <TooltipContent>
                  <p>Print to browser console and assign to window.thing</p>
                </TooltipContent>
              </Tooltip>
            </>
          )}
        </div>
      )}
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

    if (line.text.endsWith("/**")) {
      for (let i = line.number + 1; i <= state.doc.lines; i++) {
        const nextLine = state.doc.line(i);
        if (nextLine.text.includes("*/")) {
          return collapseTo(nextLine);
        }
      }
    }

    const pairs = ["{}", "[]"];
    for (const pair of pairs) {
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
