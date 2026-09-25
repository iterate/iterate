"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Check, Copy } from "lucide-react";
import { basicSetup, EditorView } from "codemirror";
import { json } from "@codemirror/lang-json";
import { yaml } from "@codemirror/lang-yaml";
import { foldService } from "@codemirror/language";
import { search, searchKeymap } from "@codemirror/search";
import type { Extension, Line } from "@codemirror/state";
import { keymap } from "@codemirror/view";
import { vsCodeLight } from "@fsegurai/codemirror-theme-bundle";
import { toast } from "sonner";
import { stringify as stringifyYaml } from "yaml";
import { cn } from "cn";
import { Tooltip, TooltipContent, TooltipTrigger } from "./tooltip.tsx";

export interface CodeBlockProps {
  code: string;
  /** The language's CodeMirror support, and any folds of its own; the same instance on every
   *  render, since a new one rebuilds the view. */
  language: Extension;
  className?: string;
  /** False hides the gutter, fold arrows included. */
  showLineNumbers?: boolean;
  /** The buttons in the top-right corner; one that copies `code` unless given. */
  toolbar?: ReactNode;
}

/** Read-only code with search, folding and a copy button: the agents app's scripts and model
 *  responses (code-block.tsx gives it their grammars), and {@link SerializedObjectCodeBlock}'s data. */
export function CodeBlock({
  code,
  language,
  className,
  showLineNumbers = true,
  toolbar = <CopyButton label="Copy code" text={() => code} />,
}: CodeBlockProps) {
  const extensions = useMemo(
    () => [
      basicSetup,
      vsCodeLight,
      search({ top: true }),
      foldPromptBlocks(),
      language,
      keymap.of(searchKeymap),
      EditorView.editable.of(false),
      EditorView.contentAttributes.of({ tabindex: "0" }),
      EditorView.lineWrapping,
      showLineNumbers ? [] : EditorView.theme({ ".cm-gutters": { display: "none" } }),
    ],
    [language, showLineNumbers],
  );

  return (
    <div className={cn("relative flex min-h-0 flex-col", className)}>
      <div className="min-h-0 flex-1 overflow-hidden overflow-y-auto rounded border">
        <ReadOnlyCodeMirror value={code} extensions={extensions} />
      </div>
      <div className="absolute top-1 right-1 flex items-center gap-0.5 rounded bg-background px-1 py-0.5 text-xs opacity-40 transition-opacity hover:opacity-90">
        {toolbar}
      </div>
    </div>
  );
}

export interface SerializedObjectCodeBlockProps {
  data: unknown;
  className?: string;
  /** The YAML/JSON switch; YAML first. */
  showToggle?: boolean;
}

/** Any value as YAML or JSON, with a button to copy each. */
export function SerializedObjectCodeBlock({
  data,
  className,
  showToggle = true,
}: SerializedObjectCodeBlockProps) {
  const [format, setFormat] = useState<"yaml" | "json">("yaml");
  const code = useMemo(() => serializeData(data, format), [data, format]);
  return (
    <CodeBlock
      code={code}
      language={dataLanguages[format]}
      className={className}
      toolbar={
        <>
          {showToggle ? (
            <button
              type="button"
              onClick={() => setFormat((value) => (value === "yaml" ? "json" : "yaml"))}
              className="rounded px-1.5 py-0.5 text-xs font-medium hover:bg-muted"
            >
              {format === "yaml" ? "YAML" : "JSON"}
            </button>
          ) : null}
          <CopyButton label="Copy YAML" text={() => serializeData(data, "yaml")} />
          <CopyButton label="Copy JSON" text={() => serializeData(data, "json")} />
        </>
      }
    />
  );
}

/** A read-only view of `value`, rebuilt when `extensions` change. A new `value` is swapped into the
 *  existing view instead, so a streaming model response does not rebuild it on every token. */
function ReadOnlyCodeMirror({ value, extensions }: { value: string; extensions: Extension }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const valueRef = useRef(value);

  // The rebuild below reads the latest value without depending on it. Assigned in an effect
  // declared before it, so a rebuild in the same commit sees this commit's value.
  useEffect(() => {
    valueRef.current = value;
  }, [value]);

  useEffect(() => {
    if (!containerRef.current) return;
    const view = new EditorView({
      doc: valueRef.current,
      extensions,
      parent: containerRef.current,
    });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, [extensions]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view || view.state.doc.toString() === value) return;
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } });
  }, [value]);

  return <div ref={containerRef} />;
}

function CopyButton({ label, text }: { label: string; text: () => string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text());
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2_000);
      toast.success("Copied to clipboard");
    } catch {
      toast.error("Failed to copy");
    }
  };
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            onClick={() => void copy()}
            className="flex h-3 w-3 items-center justify-center rounded"
          />
        }
      >
        {copied ? <Check className="h-2 w-2 text-green-500" /> : <Copy className="h-2 w-2" />}
      </TooltipTrigger>
      <TooltipContent>
        <p>{label}</p>
      </TooltipContent>
    </Tooltip>
  );
}

const dataLanguages = {
  yaml: [yaml(), foldBracketsAndDocComments()],
  json: [json(), foldBracketsAndDocComments()],
};

function serializeData(data: unknown, format: "yaml" | "json") {
  try {
    if (data === undefined) {
      return format === "yaml" ? "undefined" : '"undefined"';
    }

    // oxlint-disable-next-line iterate/simple-truthiness-check -- `data` is any JSON value: only null itself prints as null; 0, false and "" must serialize as themselves
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

/** Folds a prompt's blocks: an `<tag>` line to its `</tag>`, a fence to its close, and a markdown
 *  heading to the next heading or dedent. */
function foldPromptBlocks() {
  return foldService.of((state, lineStart, lineEnd) => {
    const line = state.doc.lineAt(lineStart);

    if (line.text.match(/^\s*<\S+>$/)) {
      const closeTag = line.text.replace("<", "</");
      for (let i = line.number + 1; i <= state.doc.lines; i++) {
        const nextLine = state.doc.line(i);
        if (nextLine.text === closeTag) {
          return foldTo(lineEnd, nextLine);
        }
      }
    }

    if (line.text.match(/^\s*```\w*\s*$/)) {
      const closeTag = line.text.slice(0, line.text.lastIndexOf("`") + 1);
      for (let i = line.number + 1; i <= state.doc.lines; i++) {
        const nextLine = state.doc.line(i);
        if (nextLine.text === closeTag) {
          return foldTo(lineEnd, nextLine);
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

/** Serialized data's extra folds, tried after {@link foldPromptBlocks}: a `/**` line to its `*\/`,
 *  and a line ending `{` or `[` to the `}` or `]` at its own indent. */
function foldBracketsAndDocComments() {
  return foldService.of((state, lineStart, lineEnd) => {
    const line = state.doc.lineAt(lineStart);

    if (line.text.endsWith("/**")) {
      for (let i = line.number + 1; i <= state.doc.lines; i++) {
        const nextLine = state.doc.line(i);
        if (nextLine.text.includes("*/")) {
          return foldTo(lineEnd, nextLine);
        }
      }
    }

    for (const pair of ["{}", "[]"]) {
      if (line.text.trimEnd().endsWith(pair[0])) {
        const indent = line.text.match(/^\s*/)?.[0] || "";
        for (let i = line.number + 1; i <= state.doc.lines; i++) {
          const nextLine = state.doc.line(i);
          if (nextLine.text === indent + pair[1]) {
            return foldTo(lineEnd, nextLine);
          }
        }
      }
    }

    return null;
  });
}

/** A fold from the end of the opening line to the closing line's first non-blank character. */
function foldTo(lineEnd: number, closing: Line) {
  return { from: lineEnd, to: closing.from + closing.text.split(/\S/)[0].length };
}
