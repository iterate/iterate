import clsx from "clsx";
import { Check, Copy, Terminal } from "lucide-react";
import { useState, useEffect, useRef } from "react";
import { toast } from "sonner";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { basicSetup, EditorView } from "codemirror";
import { json } from "@codemirror/lang-json";
import { yaml } from "@codemirror/lang-yaml";
import { search, searchKeymap } from "@codemirror/search";
import { keymap } from "@codemirror/view";
import { vsCodeDark, vsCodeLight } from "@fsegurai/codemirror-theme-bundle";
import { useTheme } from "next-themes";
import { Switch } from "./ui/switch.js";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip.js";

// Simple CodeMirror wrapper that uses EditorView directly
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
  data: any;
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

  // Generate the code string based on current format with defensive checks
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
    // Handle serialization errors (e.g., circular references)
    console.error("Serialization error:", error);
    code =
      currentFormat === "yaml"
        ? `# Error serializing data\n# ${error instanceof Error ? error.message : "Unknown error"}`
        : `{\n  "error": "Failed to serialize data",\n  "message": "${error instanceof Error ? error.message : "Unknown error"}"\n}`;
  }

  // Ensure code is always a string
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
    } catch (error) {
      console.error("Failed to copy JSON:", error);
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
    } catch (error) {
      console.error("Failed to copy YAML:", error);
      toast.error("Failed to copy YAML to clipboard");
    }
  };

  const handleToggle = () => {
    setCurrentFormat(currentFormat === "yaml" ? "json" : "yaml");
  };

  // Extensions with search support
  const lang = currentFormat === "yaml" ? yaml : json;
  const codeMirrorTheme = resolvedTheme === "dark" ? vsCodeDark : vsCodeLight;
  const extensions: CodeMirrorProps["extensions"] = [
    basicSetup,
    codeMirrorTheme,
    lang(),
    search({ top: true }),
    keymap.of(searchKeymap),
    EditorView.editable.of(false), // This is enough for readonly
    EditorView.contentAttributes.of({ tabindex: "0" }), // Make focusable for keyboard shortcutss
  ];

  return (
    <div className={clsx("relative flex flex-col", className)}>
      <div className="cm-SerializedObjectCodeBlock rounded overflow-hidden overflow-y-auto flex-1 min-h-0">
        <CodeMirror value={code} extensions={extensions} />
      </div>

      {/* Controls */}
      {(showToggle || showCopyButton) && (
        <div className="absolute top-1 right-1 flex items-center gap-0.5 px-1 py-0.5 bg-white dark:bg-gray-800 rounded text-xs opacity-40 hover:opacity-90 transition-opacity">
          {showToggle && (
            <>
              <span
                className={clsx("text-xs", {
                  "text-gray-500": currentFormat !== "yaml",
                  "text-gray-900 dark:text-gray-100": currentFormat === "yaml",
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
                className={clsx("text-xs", {
                  "text-gray-500": currentFormat !== "json",
                  "text-gray-900 dark:text-gray-100": currentFormat === "json",
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
                      console.log("Object printed to console:", data);
                      (window as any).thing = data;
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

// Keep the old component for backward compatibility
export function YamlCodeBlock({
  code,
  className,
  showCopyAsYAMLButton = true,
  showCopyAsJSONButton = true,
}: {
  code: string;
  className?: string;
  showCopyAsYAMLButton?: boolean;
  showCopyAsJSONButton?: boolean;
}) {
  // Parse the input code to get the data object
  let data: any;

  // Handle undefined/null code
  if (code === undefined || code === null) {
    data = code;
  } else if (typeof code !== "string") {
    // If code is not a string, use it directly as data
    data = code;
  } else {
    // Try to parse the string
    try {
      // First try to parse as YAML
      data = parseYaml(code);
    } catch {
      try {
        // If YAML parsing fails, try JSON
        data = JSON.parse(code);
      } catch {
        // If both fail, treat as raw string
        data = code;
      }
    }
  }

  return (
    <SerializedObjectCodeBlock
      data={data}
      className={className}
      initialFormat="yaml"
      showToggle={showCopyAsYAMLButton && showCopyAsJSONButton}
      showCopyButton={showCopyAsYAMLButton || showCopyAsJSONButton}
    />
  );
}
