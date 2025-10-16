import Editor from "@monaco-editor/react";
import type { OnMount } from "@monaco-editor/react";
import { useSessionStorage } from "usehooks-ts";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { useTheme } from "next-themes";
import {
  ChevronDown,
  ChevronRight,
  File,
  FileCode,
  FileJson,
  FileText,
  Braces,
  Settings,
} from "lucide-react";
import dedent from "dedent";
import { Button } from "../../components/ui/button.tsx";
import { cn } from "../../lib/utils.ts";
import { useTRPC } from "../../lib/trpc.ts";
import { IterateLetterI } from "../../components/ui/iterate-logos.tsx";

interface FileTreeNode {
  name: string;
  path: string;
  type: "file" | "folder";
  children?: FileTreeNode[];
}

// Get appropriate icon for file type
function getFileIcon(filename: string) {
  // Special case for iterate.config.ts
  if (filename === "iterate.config.ts") {
    return <IterateLetterI className="h-3 w-3 flex-shrink-0" />;
  }

  const extension = filename.split(".").pop()?.toLowerCase();

  switch (extension) {
    case "md":
    case "markdown":
      return <FileText className="h-3 w-3 flex-shrink-0 text-blue-500" />;
    case "ts":
    case "tsx":
      return <FileCode className="h-3 w-3 flex-shrink-0 text-blue-600" />;
    case "js":
    case "jsx":
      return <FileCode className="h-3 w-3 flex-shrink-0 text-yellow-500" />;
    case "json":
      return <FileJson className="h-3 w-3 flex-shrink-0 text-yellow-600" />;
    case "yaml":
    case "yml":
      return <Braces className="h-3 w-3 flex-shrink-0 text-purple-500" />;
    case "toml":
      return <Settings className="h-3 w-3 flex-shrink-0 text-gray-500" />;
    default:
      return <File className="h-3 w-3 flex-shrink-0" />;
  }
}

// Build a tree structure from flat file paths
function buildFileTree(filePaths: string[]): FileTreeNode[] {
  const root: FileTreeNode[] = [];
  const nodeMap = new Map<string, FileTreeNode>();

  // Filter out empty files and sort
  const validPaths = filePaths.filter((path) => path.trim() !== "").sort();

  for (const path of validPaths) {
    const parts = path.split("/");
    let currentPath = "";

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const parentPath = currentPath;
      currentPath = currentPath ? `${currentPath}/${part}` : part;

      if (!nodeMap.has(currentPath)) {
        const isFile = i === parts.length - 1;
        const node: FileTreeNode = {
          name: part,
          path: currentPath,
          type: isFile ? "file" : "folder",
          children: isFile ? undefined : [],
        };

        nodeMap.set(currentPath, node);

        if (parentPath) {
          const parentNode = nodeMap.get(parentPath);
          if (parentNode?.children) {
            parentNode.children.push(node);
          }
        } else {
          root.push(node);
        }
      }
    }
  }

  // Sort: folders first, then files, both alphabetically
  const sortNodes = (nodes: FileTreeNode[]) => {
    nodes.sort((a, b) => {
      if (a.type !== b.type) {
        return a.type === "folder" ? -1 : 1;
      }
      return a.name.localeCompare(b.name);
    });
    nodes.forEach((node) => {
      if (node.children) {
        sortNodes(node.children);
      }
    });
  };

  sortNodes(root);
  return root;
}

interface FileTreeViewProps {
  nodes: FileTreeNode[];
  selectedFile: string | null;
  onFileSelect: (path: string) => void;
  isFileEdited: (path: string) => boolean;
  collapsedFolders: Set<string>;
  onToggleFolder: (path: string) => void;
  level?: number;
}

function FileTreeView({
  nodes,
  selectedFile,
  onFileSelect,
  isFileEdited,
  collapsedFolders,
  onToggleFolder,
  level = 0,
}: FileTreeViewProps) {
  return (
    <>
      {nodes.map((node) => {
        const isCollapsed = collapsedFolders.has(node.path);
        const hasChildren = node.children && node.children.length > 0;

        return (
          <div key={node.path}>
            <button
              onClick={() => {
                if (node.type === "folder") {
                  onToggleFolder(node.path);
                } else {
                  onFileSelect(node.path);
                }
              }}
              className={cn(
                "w-full text-left px-2 py-1 text-xs flex items-center gap-1 hover:bg-accent rounded-sm",
                selectedFile === node.path && node.type === "file" && "bg-accent",
              )}
              style={{ paddingLeft: `${level * 12 + 8}px` }}
            >
              {node.type === "folder" ? (
                <>
                  {hasChildren ? (
                    isCollapsed ? (
                      <ChevronRight className="h-3 w-3 flex-shrink-0" />
                    ) : (
                      <ChevronDown className="h-3 w-3 flex-shrink-0" />
                    )
                  ) : (
                    <span className="w-3" />
                  )}
                </>
              ) : (
                <>{getFileIcon(node.name)}</>
              )}
              <span className="truncate flex-1">
                {node.name}
                {node.type === "file" && isFileEdited(node.path) && (
                  <span className="text-orange-500">*</span>
                )}
              </span>
            </button>
            {node.type === "folder" && node.children && !isCollapsed && (
              <FileTreeView
                nodes={node.children}
                selectedFile={selectedFile}
                onFileSelect={onFileSelect}
                isFileEdited={isFileEdited}
                collapsedFolders={collapsedFolders}
                onToggleFolder={onToggleFolder}
                level={level + 1}
              />
            )}
          </div>
        );
      })}
    </>
  );
}

interface IDEProps {
  repositoryNameWithOwner: string;
  refName: string;
}

function IDE({ repositoryNameWithOwner, refName }: IDEProps) {
  const trpc = useTRPC();
  const [bump, setBump] = useState(0);
  const getRepoFilesystemQueryOptions = trpc.estate.getRepoFilesystem.queryOptions({
    repositoryNameWithOwner,
    refName,
    ...({ bump } as {}),
  });
  const getRepoFileSystemQuery = useQuery({
    ...getRepoFilesystemQueryOptions,
    placeholderData: (old) => old,
  });

  const saveFileMutation = useMutation(
    trpc.estate.updateRepo.mutationOptions({
      onSuccess: () => setBump((prev) => prev + 1),
    }),
  );

  const { filesystem, sha } = getRepoFileSystemQuery.data || { filesystem: {}, sha: "" };
  const [selectedFile, setSelectedFile] = useSessionStorage<string | null>(
    "iterate-selected-file",
    null,
  );
  const [localEdits, setLocalEdits] = useSessionStorage<Record<string, string>>(
    "iterate-local-edits",
    {},
  );
  const [collapsedFoldersRecord, setCollapsedFolders] = useSessionStorage<Record<string, boolean>>(
    "iterate-collapsed-folders",
    {},
  );
  const collapsedFolders = useMemo(
    () =>
      new Set(Object.keys(collapsedFoldersRecord).filter((path) => collapsedFoldersRecord[path])),
    [collapsedFoldersRecord],
  );

  // Derive file contents by merging filesystem with local edits
  const fileContents = useMemo(() => ({ ...filesystem, ...localEdits }), [filesystem, localEdits]);

  // Derive valid selected file (reset if file no longer exists)
  const validSelectedFile = useMemo(() => {
    if (selectedFile && selectedFile in fileContents) {
      return selectedFile;
    }
    return null;
  }, [selectedFile, fileContents]);

  // Build file tree from filesystem
  const fileTree = useMemo(() => buildFileTree(Object.keys(fileContents)), [fileContents]);
  const currentContent = validSelectedFile ? fileContents[validSelectedFile] : "";

  const handleToggleFolder = (path: string) => {
    setCollapsedFolders((prev) => ({ ...prev, [path]: !prev[path] }));
  };

  // Check if a file has been edited
  const isFileEdited = (filename: string): boolean => {
    return fileContents[filename] !== filesystem[filename];
  };

  // Check if current file has unsaved changes
  const hasUnsavedChanges = validSelectedFile ? isFileEdited(validSelectedFile) : false;

  const handleContentChange = (newContent: string) => {
    if (validSelectedFile) {
      setLocalEdits((prev) => ({
        ...prev,
        [validSelectedFile]: newContent,
      }));
    }
  };

  const handleSave = () => {
    if (validSelectedFile) {
      saveFileMutation.mutate(
        {
          branch: {
            repositoryNameWithOwner,
            branchName: refName,
          },
          expectedHeadOid: sha,
          message: { headline: `in-browser changes to ${validSelectedFile}` },
          fileChanges: {
            additions: [
              { path: validSelectedFile, contents: btoa(fileContents[validSelectedFile]) },
            ],
          },
        },
        {
          onSuccess: () => {
            // Clear local edits for the saved file
            setLocalEdits((prev) => {
              const next = { ...prev };
              delete next[validSelectedFile];
              return next;
            });
          },
        },
      );
    }
  };

  const getLanguage = (filename: string) => {
    if (filename.endsWith(".ts")) return "typescript";
    if (filename.endsWith(".tsx")) return "typescriptreact";
    if (filename.endsWith(".json")) return "json";
    if (filename.endsWith(".yaml")) return "yaml";
    if (filename.endsWith(".yml")) return "yaml";
    if (filename.endsWith(".md")) return "markdown";
    if (filename.endsWith(".mdx")) return "markdown";
    if (filename.endsWith(".mdx")) return "markdown";
    return "markdown";
  };

  const editorRef = useRef<Parameters<OnMount> | null>(null);

  const getEditor = () => editorRef.current!!![0];
  const getMonaco = () => editorRef.current!!![1];

  const { resolvedTheme } = useTheme();

  // // Update document when value changes externally
  // useEffect(() => {
  //   if (viewRef.current && viewRef.current.state.doc.toString() !== value) {
  //     viewRef.current.dispatch({
  //       changes: { from: 0, to: viewRef.current.state.doc.length, insert: value },
  //     });
  //   }
  // }, [value]);
  const onMount = useCallback<OnMount>((...params) => {
    editorRef.current = params;
  }, []);

  useEffect(() => {
    // capture cmd-s/ctrl-s
    const onKeyDown = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key === "s") {
        e.preventDefault();
      }
    };
    document.addEventListener("keydown", onKeyDown, false);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  const language = getLanguage(validSelectedFile || "");

  return (
    <div className="flex h-[calc(100vh-8rem)] border rounded-lg overflow-hidden">
      {/* Left sidebar - File tree */}
      <div className="w-48 flex-shrink-0 border-r bg-muted/50 overflow-y-auto">
        <div className="p-2">
          <h3 className="text-xs font-semibold mb-2 px-2 py-1">Files</h3>
          <FileTreeView
            nodes={fileTree}
            selectedFile={validSelectedFile}
            onFileSelect={setSelectedFile}
            isFileEdited={isFileEdited}
            collapsedFolders={collapsedFolders}
            onToggleFolder={handleToggleFolder}
          />
        </div>
      </div>

      {/* Main panel - Editor */}
      <div className="flex-1 min-w-0 flex flex-col">
        {validSelectedFile ? (
          <>
            <div className="border-b p-3 flex items-center justify-between bg-background">
              <span className="text-sm font-medium">
                {validSelectedFile}
                {hasUnsavedChanges && <span className="text-orange-500">*</span>}
              </span>
              <Button
                onClick={handleSave}
                disabled={
                  !hasUnsavedChanges ||
                  saveFileMutation.isPending ||
                  getRepoFileSystemQuery.isPending
                }
                size="sm"
              >
                {saveFileMutation.isPending || getRepoFileSystemQuery.isPending
                  ? "Saving..."
                  : "Save"}
              </Button>
            </div>
            <div className="flex-1">
              <Editor
                // make the editor (roughly) full window height minus the navbar at the top
                height="calc(100vh - 240px)"
                defaultLanguage={language || "markdown"}
                language={language}
                onChange={(val) => handleContentChange(val || "")}
                value={currentContent}
                theme={resolvedTheme === "dark" ? "vs-dark" : "light"}
                // options={{
                //   quickSuggestions: false,
                //   suggest: { showKeywords: false },
                //   wordBasedSuggestions: false,
                //   wordWrap: "on",
                //   colorDecorators: true,
                // }}
                beforeMount={(monaco) => {
                  monaco.languages.typescript.typescriptDefaults.setCompilerOptions({
                    ...monaco.languages.typescript.typescriptDefaults.getCompilerOptions(),
                    types: ["node_modules/*"],
                    strict: true,
                    lib: ["es6"],
                  });
                  monaco.languages.typescript.typescriptDefaults.addExtraLib(
                    "export const a: 1",
                    "file:///node_modules/@types/testmodule/index.d.ts",
                  );
                  // monaco.languages.typescript.typescriptDefaults.addExtraLib(
                  //   dedent`
                  //     export const matchers: {foo: string}
                  //   `,
                  //   `inmemory://model/types.d.ts`,
                  // );
                  // monaco.languages.typescript.typescriptDefaults.addExtraLib(
                  //   dedent`
                  //     export const matchers: {foo: string}
                  //   `,
                  //   `file:///node_modules/axios/index.d.ts`,
                  // );
                  // // monaco.languages.typescript.typescriptDefaults.addExtraLib(
                  //   dedent`
                  //     export const matchers: {foo: string}
                  //   `,
                  //   `file:///node_modules/axios/index.d.ts`,
                  // )
                  monaco.editor.createModel(
                    dedent`
                      declare module "myModule" {
                        export type MyType = 'myValue';
                        export const myValue = 'myValue';
                      }
                    `,
                    "typescript",
                    monaco.Uri.file("/myModule.d.ts"),
                  );
                  monaco.editor.createModel(
                    dedent`
                      declare module "@iterate-com/sdk" {
                        ${sdkdts}
                      }
                    `,
                    "typescript",
                    monaco.Uri.file("/iterate-com-sdk.d.ts"),
                  );
                }}
                onMount={onMount}
              />
            </div>
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center text-muted-foreground">
            Select a file to edit
          </div>
        )}
      </div>
    </div>
  );
}

export default function EstateEditor() {
  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-2xl font-bold">Estate Editor</h1>
        <p className="text-muted-foreground">
          Edit estate configuration files. Changes will be saved to GitHub.
        </p>
      </div>
      <IDE repositoryNameWithOwner={"iterate-estates/mktest1"} refName={"main"} />
    </div>
  );
}

const sdkdts = `
import dedent from "dedent";
import { z } from "zod";
import z$3, { z as z$2 } from "zod/v4";
import { RequireAtLeastOne } from "type-fest";

//#region backend/utils/type-helpers.d.ts
export declare const sss: z$2.ZodString;
declare const JSONSerializable: z$2.ZodType<JSONSerializable>;
interface JSONSerializableArray extends ReadonlyArray<JSONSerializable> {}
interface JSONSerializableObject {
  readonly [key: string]: JSONSerializable;
}
type JSONPrimitive = string | number | boolean | null | undefined;
type JSONSerializable = JSONPrimitive | JSONSerializableArray | JSONSerializableObject;
//#endregion
//#region backend/agent/prompt-fragments.d.ts
type PromptFragment = null | string | {
  tag?: string;
  content: PromptFragment | PromptFragment[];
} | PromptFragment[];
declare const PromptFragment: z$2.ZodType<PromptFragment>;
/**
 * Create a prompt fragment with an optional XML tag wrapper.
 * This is a utility function for creating structured prompt fragments.
 *
 * @param tag - The XML tag name to wrap the content
 * @param content - The fragment content(s) - can be strings, objects, or arrays
 * @returns A PromptFragmentObject with the specified tag and content
 *
 * @example
 * // Simple fragment
 * f("role", "You are a helpful assistant")
 *
 * // Nested fragments
 * f("rules",
 *   "Follow these guidelines:",
 *   f("important", "Be concise"),
 *   f("important", "Be accurate")
 * )
 */
declare function f(tag: string, ...content: PromptFragment[]): z$2.infer<typeof PromptFragment>;
//#endregion
//#region backend/agent/tool-schemas.d.ts

declare const ToolSpec: z$3.ZodDiscriminatedUnion<[z$3.ZodObject<{
  type: z$3.ZodLiteral<"openai_builtin">;
  openAITool: z$3.ZodDiscriminatedUnion<[z$3.ZodObject<{
    type: z$3.ZodLiteral<"file_search">;
    vector_store_ids: z$3.ZodArray<z$3.ZodString>;
    filters: z$3.ZodOptional<z$3.ZodNullable<z$3.ZodAny>>;
    max_num_results: z$3.ZodOptional<z$3.ZodNumber>;
    ranking_options: z$3.ZodOptional<z$3.ZodAny>;
  }, z$3.core.$strip>, z$3.ZodObject<{
    type: z$3.ZodUnion<readonly [z$3.ZodLiteral<"web_search">, z$3.ZodLiteral<"web_search_2025_08_26">, z$3.ZodPipe<z$3.ZodPipe<z$3.ZodLiteral<"web_search_preview">, z$3.ZodTransform<string, "web_search_preview">>, z$3.ZodLiteral<"web_search">>, z$3.ZodPipe<z$3.ZodPipe<z$3.ZodLiteral<"web_search_preview_2025_03_11">, z$3.ZodTransform<string, "web_search_preview_2025_03_11">>, z$3.ZodLiteral<"web_search_2025_08_26">>]>;
    search_context_size: z$3.ZodOptional<z$3.ZodEnum<{
      low: "low";
      medium: "medium";
      high: "high";
    }>>;
    user_location: z$3.ZodOptional<z$3.ZodNullable<z$3.ZodObject<{
      type: z$3.ZodLiteral<"approximate">;
      city: z$3.ZodOptional<z$3.ZodNullable<z$3.ZodString>>;
      country: z$3.ZodOptional<z$3.ZodNullable<z$3.ZodString>>;
      region: z$3.ZodOptional<z$3.ZodNullable<z$3.ZodString>>;
      timezone: z$3.ZodOptional<z$3.ZodNullable<z$3.ZodString>>;
    }, z$3.core.$strip>>>;
  }, z$3.core.$strip>, z$3.ZodObject<{
    type: z$3.ZodLiteral<"computer_use_preview">;
    display_height: z$3.ZodNumber;
    display_width: z$3.ZodNumber;
    environment: z$3.ZodEnum<{
      windows: "windows";
      mac: "mac";
      linux: "linux";
      ubuntu: "ubuntu";
      browser: "browser";
    }>;
  }, z$3.core.$strip>, z$3.ZodObject<{
    type: z$3.ZodLiteral<"mcp">;
    server_label: z$3.ZodString;
    server_url: z$3.ZodOptional<z$3.ZodString>;
    allowed_tools: z$3.ZodOptional<z$3.ZodNullable<z$3.ZodUnion<readonly [z$3.ZodArray<z$3.ZodString>, z$3.ZodObject<{
      tool_names: z$3.ZodOptional<z$3.ZodArray<z$3.ZodString>>;
    }, z$3.core.$strip>]>>>;
    headers: z$3.ZodOptional<z$3.ZodNullable<z$3.ZodRecord<z$3.ZodString, z$3.ZodString>>>;
    require_approval: z$3.ZodOptional<z$3.ZodNullable<z$3.ZodUnion<readonly [z$3.ZodLiteral<"always">, z$3.ZodLiteral<"never">, z$3.ZodObject<{
      always: z$3.ZodOptional<z$3.ZodObject<{
        tool_names: z$3.ZodOptional<z$3.ZodArray<z$3.ZodString>>;
      }, z$3.core.$strip>>;
      never: z$3.ZodOptional<z$3.ZodObject<{
        tool_names: z$3.ZodOptional<z$3.ZodArray<z$3.ZodString>>;
      }, z$3.core.$strip>>;
    }, z$3.core.$strip>]>>>;
  }, z$3.core.$strip>, z$3.ZodObject<{
    type: z$3.ZodLiteral<"code_interpreter">;
    container: z$3.ZodUnion<readonly [z$3.ZodString, z$3.ZodObject<{
      type: z$3.ZodLiteral<"auto">;
      file_ids: z$3.ZodOptional<z$3.ZodArray<z$3.ZodString>>;
    }, z$3.core.$strip>]>;
  }, z$3.core.$strip>, z$3.ZodObject<{
    type: z$3.ZodLiteral<"image_generation">;
    background: z$3.ZodOptional<z$3.ZodEnum<{
      auto: "auto";
      transparent: "transparent";
      opaque: "opaque";
    }>>;
    input_image_mask: z$3.ZodOptional<z$3.ZodObject<{
      file_id: z$3.ZodOptional<z$3.ZodString>;
      image_url: z$3.ZodOptional<z$3.ZodString>;
    }, z$3.core.$strip>>;
    model: z$3.ZodOptional<z$3.ZodLiteral<"gpt-image-1">>;
    moderation: z$3.ZodOptional<z$3.ZodEnum<{
      low: "low";
      auto: "auto";
    }>>;
    output_compression: z$3.ZodOptional<z$3.ZodNumber>;
    output_format: z$3.ZodOptional<z$3.ZodEnum<{
      png: "png";
      webp: "webp";
      jpeg: "jpeg";
    }>>;
    partial_images: z$3.ZodOptional<z$3.ZodNumber>;
    quality: z$3.ZodOptional<z$3.ZodEnum<{
      low: "low";
      medium: "medium";
      high: "high";
      auto: "auto";
    }>>;
    size: z$3.ZodOptional<z$3.ZodEnum<{
      auto: "auto";
      "1024x1024": "1024x1024";
      "1024x1536": "1024x1536";
      "1536x1024": "1536x1024";
    }>>;
  }, z$3.core.$strip>, z$3.ZodObject<{
    type: z$3.ZodLiteral<"local_shell">;
  }, z$3.core.$strip>], "type">;
  triggerLLMRequest: z$3.ZodOptional<z$3.ZodDefault<z$3.ZodBoolean>>;
  hideOptionalInputs: z$3.ZodOptional<z$3.ZodDefault<z$3.ZodBoolean>>;
}, z$3.core.$strip>, z$3.ZodObject<{
  type: z$3.ZodLiteral<"agent_durable_object_tool">;
  methodName: z$3.ZodString;
  passThroughArgs: z$3.ZodOptional<z$3.ZodNullable<z$3.ZodRecord<z$3.ZodString, z$3.ZodType<JSONSerializable, unknown, z$3.core.$ZodTypeInternals<JSONSerializable, unknown>>>>>;
  overrideName: z$3.ZodOptional<z$3.ZodNullable<z$3.ZodString>>;
  overrideDescription: z$3.ZodOptional<z$3.ZodNullable<z$3.ZodString>>;
  overrideInputJSONSchema: z$3.ZodOptional<z$3.ZodNullable<z$3.ZodAny>>;
  strict: z$3.ZodOptional<z$3.ZodDefault<z$3.ZodBoolean>>;
  triggerLLMRequest: z$3.ZodOptional<z$3.ZodDefault<z$3.ZodBoolean>>;
  hideOptionalInputs: z$3.ZodOptional<z$3.ZodDefault<z$3.ZodBoolean>>;
  statusIndicatorText: z$3.ZodOptional<z$3.ZodNullable<z$3.ZodString>>;
}, z$3.core.$strip>], "type">;
type ToolSpec = z$3.infer<typeof ToolSpec>;
//#endregion
//#region backend/agent/context-schemas.d.ts
type ContextRuleMatcher = {
  type: "always";
} | {
  type: "never";
} | {
  type: "jsonata";
  expression: string;
} | {
  type: "and";
  matchers: ContextRuleMatcher[];
} | {
  type: "or";
  matchers: ContextRuleMatcher[];
} | {
  type: "not";
  matcher: ContextRuleMatcher;
} | {
  type: "timeWindow";
  windows: TimeWindow[];
  tz?: string;
};
declare const ContextRuleMatcher: z.ZodType<ContextRuleMatcher>;
declare const TimeWindow: z.ZodObject<{
  weekdays: z.ZodOptional<z.ZodArray<z.ZodUnion<[z.ZodEnum<{
    MO: "MO";
    TU: "TU";
    WE: "WE";
    TH: "TH";
    FR: "FR";
    SA: "SA";
    SU: "SU";
  }>, z.ZodNumber]>>>;
  months: z.ZodOptional<z.ZodArray<z.ZodUnion<[z.ZodEnum<{
    JAN: "JAN";
    FEB: "FEB";
    MAR: "MAR";
    APR: "APR";
    MAY: "MAY";
    JUN: "JUN";
    JUL: "JUL";
    AUG: "AUG";
    SEP: "SEP";
    OCT: "OCT";
    NOV: "NOV";
    DEC: "DEC";
  }>, z.ZodNumber]>>>;
  daysOfMonth: z.ZodOptional<z.ZodArray<z.ZodNumber>>;
  timeOfDay: z.ZodOptional<z.ZodObject<{
    start: z.ZodString;
    end: z.ZodString;
  }, z.core.$strip>>;
  exact: z.ZodOptional<z.ZodObject<{
    month: z.ZodNumber;
    day: z.ZodNumber;
    hour: z.ZodNumber;
    minute: z.ZodNumber;
  }, z.core.$strip>>;
}, z.core.$strip>;
type TimeWindow = z.infer<typeof TimeWindow>;
/**
 * Represents context (such as prompts and tool specs) to be provided to
 * an LLM via our AgentCore class
 */
type ContextItem = RequireAtLeastOne<{
  prompt: PromptFragment;
  tools: ToolSpec[];
}> & {
  key: string;
  description?: string;
};
declare const ContextItem: z.ZodObject<{
  key: z.ZodString;
  description: z.ZodOptional<z.ZodString>;
  prompt: z.ZodOptional<z.ZodType<PromptFragment, unknown, z.core.$ZodTypeInternals<PromptFragment, unknown>>>;
  tools: z.ZodOptional<z.ZodArray<z.ZodDiscriminatedUnion<[z.ZodObject<{
    type: z.ZodLiteral<"openai_builtin">;
    openAITool: z.ZodDiscriminatedUnion<[z.ZodObject<{
      type: z.ZodLiteral<"file_search">;
      vector_store_ids: z.ZodArray<z.ZodString>;
      filters: z.ZodOptional<z.ZodNullable<z.ZodAny>>;
      max_num_results: z.ZodOptional<z.ZodNumber>;
      ranking_options: z.ZodOptional<z.ZodAny>;
    }, z.core.$strip>, z.ZodObject<{
      type: z.ZodUnion<readonly [z.ZodLiteral<"web_search">, z.ZodLiteral<"web_search_2025_08_26">, z.ZodPipe<z.ZodPipe<z.ZodLiteral<"web_search_preview">, z.ZodTransform<string, "web_search_preview">>, z.ZodLiteral<"web_search">>, z.ZodPipe<z.ZodPipe<z.ZodLiteral<"web_search_preview_2025_03_11">, z.ZodTransform<string, "web_search_preview_2025_03_11">>, z.ZodLiteral<"web_search_2025_08_26">>]>;
      search_context_size: z.ZodOptional<z.ZodEnum<{
        low: "low";
        medium: "medium";
        high: "high";
      }>>;
      user_location: z.ZodOptional<z.ZodNullable<z.ZodObject<{
        type: z.ZodLiteral<"approximate">;
        city: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        country: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        region: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        timezone: z.ZodOptional<z.ZodNullable<z.ZodString>>;
      }, z.core.$strip>>>;
    }, z.core.$strip>, z.ZodObject<{
      type: z.ZodLiteral<"computer_use_preview">;
      display_height: z.ZodNumber;
      display_width: z.ZodNumber;
      environment: z.ZodEnum<{
        windows: "windows";
        mac: "mac";
        linux: "linux";
        ubuntu: "ubuntu";
        browser: "browser";
      }>;
    }, z.core.$strip>, z.ZodObject<{
      type: z.ZodLiteral<"mcp">;
      server_label: z.ZodString;
      server_url: z.ZodOptional<z.ZodString>;
      allowed_tools: z.ZodOptional<z.ZodNullable<z.ZodUnion<readonly [z.ZodArray<z.ZodString>, z.ZodObject<{
        tool_names: z.ZodOptional<z.ZodArray<z.ZodString>>;
      }, z.core.$strip>]>>>;
      headers: z.ZodOptional<z.ZodNullable<z.ZodRecord<z.ZodString, z.ZodString>>>;
      require_approval: z.ZodOptional<z.ZodNullable<z.ZodUnion<readonly [z.ZodLiteral<"always">, z.ZodLiteral<"never">, z.ZodObject<{
        always: z.ZodOptional<z.ZodObject<{
          tool_names: z.ZodOptional<z.ZodArray<z.ZodString>>;
        }, z.core.$strip>>;
        never: z.ZodOptional<z.ZodObject<{
          tool_names: z.ZodOptional<z.ZodArray<z.ZodString>>;
        }, z.core.$strip>>;
      }, z.core.$strip>]>>>;
    }, z.core.$strip>, z.ZodObject<{
      type: z.ZodLiteral<"code_interpreter">;
      container: z.ZodUnion<readonly [z.ZodString, z.ZodObject<{
        type: z.ZodLiteral<"auto">;
        file_ids: z.ZodOptional<z.ZodArray<z.ZodString>>;
      }, z.core.$strip>]>;
    }, z.core.$strip>, z.ZodObject<{
      type: z.ZodLiteral<"image_generation">;
      background: z.ZodOptional<z.ZodEnum<{
        auto: "auto";
        transparent: "transparent";
        opaque: "opaque";
      }>>;
      input_image_mask: z.ZodOptional<z.ZodObject<{
        file_id: z.ZodOptional<z.ZodString>;
        image_url: z.ZodOptional<z.ZodString>;
      }, z.core.$strip>>;
      model: z.ZodOptional<z.ZodLiteral<"gpt-image-1">>;
      moderation: z.ZodOptional<z.ZodEnum<{
        low: "low";
        auto: "auto";
      }>>;
      output_compression: z.ZodOptional<z.ZodNumber>;
      output_format: z.ZodOptional<z.ZodEnum<{
        png: "png";
        webp: "webp";
        jpeg: "jpeg";
      }>>;
      partial_images: z.ZodOptional<z.ZodNumber>;
      quality: z.ZodOptional<z.ZodEnum<{
        low: "low";
        medium: "medium";
        high: "high";
        auto: "auto";
      }>>;
      size: z.ZodOptional<z.ZodEnum<{
        auto: "auto";
        "1024x1024": "1024x1024";
        "1024x1536": "1024x1536";
        "1536x1024": "1536x1024";
      }>>;
    }, z.core.$strip>, z.ZodObject<{
      type: z.ZodLiteral<"local_shell">;
    }, z.core.$strip>], "type">;
    triggerLLMRequest: z.ZodOptional<z.ZodDefault<z.ZodBoolean>>;
    hideOptionalInputs: z.ZodOptional<z.ZodDefault<z.ZodBoolean>>;
  }, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"agent_durable_object_tool">;
    methodName: z.ZodString;
    passThroughArgs: z.ZodOptional<z.ZodNullable<z.ZodRecord<z.ZodString, z.ZodType<JSONSerializable, unknown, z.core.$ZodTypeInternals<JSONSerializable, unknown>>>>>;
    overrideName: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    overrideDescription: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    overrideInputJSONSchema: z.ZodOptional<z.ZodNullable<z.ZodAny>>;
    strict: z.ZodOptional<z.ZodDefault<z.ZodBoolean>>;
    triggerLLMRequest: z.ZodOptional<z.ZodDefault<z.ZodBoolean>>;
    hideOptionalInputs: z.ZodOptional<z.ZodDefault<z.ZodBoolean>>;
    statusIndicatorText: z.ZodOptional<z.ZodNullable<z.ZodString>>;
  }, z.core.$strip>], "type">>>;
}, z.core.$strip>;
declare const ContextRule: z.ZodObject<{
  key: z.ZodString;
  description: z.ZodOptional<z.ZodString>;
  prompt: z.ZodOptional<z.ZodType<PromptFragment, unknown, z.core.$ZodTypeInternals<PromptFragment, unknown>>>;
  tools: z.ZodOptional<z.ZodArray<z.ZodDiscriminatedUnion<[z.ZodObject<{
    type: z.ZodLiteral<"openai_builtin">;
    openAITool: z.ZodDiscriminatedUnion<[z.ZodObject<{
      type: z.ZodLiteral<"file_search">;
      vector_store_ids: z.ZodArray<z.ZodString>;
      filters: z.ZodOptional<z.ZodNullable<z.ZodAny>>;
      max_num_results: z.ZodOptional<z.ZodNumber>;
      ranking_options: z.ZodOptional<z.ZodAny>;
    }, z.core.$strip>, z.ZodObject<{
      type: z.ZodUnion<readonly [z.ZodLiteral<"web_search">, z.ZodLiteral<"web_search_2025_08_26">, z.ZodPipe<z.ZodPipe<z.ZodLiteral<"web_search_preview">, z.ZodTransform<string, "web_search_preview">>, z.ZodLiteral<"web_search">>, z.ZodPipe<z.ZodPipe<z.ZodLiteral<"web_search_preview_2025_03_11">, z.ZodTransform<string, "web_search_preview_2025_03_11">>, z.ZodLiteral<"web_search_2025_08_26">>]>;
      search_context_size: z.ZodOptional<z.ZodEnum<{
        low: "low";
        medium: "medium";
        high: "high";
      }>>;
      user_location: z.ZodOptional<z.ZodNullable<z.ZodObject<{
        type: z.ZodLiteral<"approximate">;
        city: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        country: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        region: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        timezone: z.ZodOptional<z.ZodNullable<z.ZodString>>;
      }, z.core.$strip>>>;
    }, z.core.$strip>, z.ZodObject<{
      type: z.ZodLiteral<"computer_use_preview">;
      display_height: z.ZodNumber;
      display_width: z.ZodNumber;
      environment: z.ZodEnum<{
        windows: "windows";
        mac: "mac";
        linux: "linux";
        ubuntu: "ubuntu";
        browser: "browser";
      }>;
    }, z.core.$strip>, z.ZodObject<{
      type: z.ZodLiteral<"mcp">;
      server_label: z.ZodString;
      server_url: z.ZodOptional<z.ZodString>;
      allowed_tools: z.ZodOptional<z.ZodNullable<z.ZodUnion<readonly [z.ZodArray<z.ZodString>, z.ZodObject<{
        tool_names: z.ZodOptional<z.ZodArray<z.ZodString>>;
      }, z.core.$strip>]>>>;
      headers: z.ZodOptional<z.ZodNullable<z.ZodRecord<z.ZodString, z.ZodString>>>;
      require_approval: z.ZodOptional<z.ZodNullable<z.ZodUnion<readonly [z.ZodLiteral<"always">, z.ZodLiteral<"never">, z.ZodObject<{
        always: z.ZodOptional<z.ZodObject<{
          tool_names: z.ZodOptional<z.ZodArray<z.ZodString>>;
        }, z.core.$strip>>;
        never: z.ZodOptional<z.ZodObject<{
          tool_names: z.ZodOptional<z.ZodArray<z.ZodString>>;
        }, z.core.$strip>>;
      }, z.core.$strip>]>>>;
    }, z.core.$strip>, z.ZodObject<{
      type: z.ZodLiteral<"code_interpreter">;
      container: z.ZodUnion<readonly [z.ZodString, z.ZodObject<{
        type: z.ZodLiteral<"auto">;
        file_ids: z.ZodOptional<z.ZodArray<z.ZodString>>;
      }, z.core.$strip>]>;
    }, z.core.$strip>, z.ZodObject<{
      type: z.ZodLiteral<"image_generation">;
      background: z.ZodOptional<z.ZodEnum<{
        auto: "auto";
        transparent: "transparent";
        opaque: "opaque";
      }>>;
      input_image_mask: z.ZodOptional<z.ZodObject<{
        file_id: z.ZodOptional<z.ZodString>;
        image_url: z.ZodOptional<z.ZodString>;
      }, z.core.$strip>>;
      model: z.ZodOptional<z.ZodLiteral<"gpt-image-1">>;
      moderation: z.ZodOptional<z.ZodEnum<{
        low: "low";
        auto: "auto";
      }>>;
      output_compression: z.ZodOptional<z.ZodNumber>;
      output_format: z.ZodOptional<z.ZodEnum<{
        png: "png";
        webp: "webp";
        jpeg: "jpeg";
      }>>;
      partial_images: z.ZodOptional<z.ZodNumber>;
      quality: z.ZodOptional<z.ZodEnum<{
        low: "low";
        medium: "medium";
        high: "high";
        auto: "auto";
      }>>;
      size: z.ZodOptional<z.ZodEnum<{
        auto: "auto";
        "1024x1024": "1024x1024";
        "1024x1536": "1024x1536";
        "1536x1024": "1536x1024";
      }>>;
    }, z.core.$strip>, z.ZodObject<{
      type: z.ZodLiteral<"local_shell">;
    }, z.core.$strip>], "type">;
    triggerLLMRequest: z.ZodOptional<z.ZodDefault<z.ZodBoolean>>;
    hideOptionalInputs: z.ZodOptional<z.ZodDefault<z.ZodBoolean>>;
  }, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"agent_durable_object_tool">;
    methodName: z.ZodString;
    passThroughArgs: z.ZodOptional<z.ZodNullable<z.ZodRecord<z.ZodString, z.ZodType<JSONSerializable, unknown, z.core.$ZodTypeInternals<JSONSerializable, unknown>>>>>;
    overrideName: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    overrideDescription: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    overrideInputJSONSchema: z.ZodOptional<z.ZodNullable<z.ZodAny>>;
    strict: z.ZodOptional<z.ZodDefault<z.ZodBoolean>>;
    triggerLLMRequest: z.ZodOptional<z.ZodDefault<z.ZodBoolean>>;
    hideOptionalInputs: z.ZodOptional<z.ZodDefault<z.ZodBoolean>>;
    statusIndicatorText: z.ZodOptional<z.ZodNullable<z.ZodString>>;
  }, z.core.$strip>], "type">>>;
  match: z.ZodOptional<z.ZodUnion<[z.ZodType<ContextRuleMatcher, unknown, z.core.$ZodTypeInternals<ContextRuleMatcher, unknown>>, z.ZodArray<z.ZodType<ContextRuleMatcher, unknown, z.core.$ZodTypeInternals<ContextRuleMatcher, unknown>>>]>>;
}, z.core.$strip>;
type ContextRule = z.infer<typeof ContextItem> & {
  match?: ContextRuleMatcher | ContextRuleMatcher[];
};
//#endregion
//#region backend/agent/context.d.ts
declare function always(): {
  type: "always";
};
declare function never(): {
  type: "never";
};
declare function jsonata(expression: string): {
  type: "jsonata";
  expression: string;
};
declare function hasParticipant(searchString: string): {
  type: "jsonata";
  expression: string;
};
declare function slackChannel(channelIdOrName: string): {
  type: "jsonata";
  expression: string;
};
declare function slackChannelHasExternalUsers(hasExternalUsers: boolean): {
  type: "jsonata";
  expression: string;
};
declare function and(...inner: ContextRuleMatcher[]): {
  type: "and";
  matchers: ContextRuleMatcher[];
};
declare function or(...inner: ContextRuleMatcher[]): {
  type: "or";
  matchers: ContextRuleMatcher[];
};
declare function not(inner: ContextRuleMatcher): {
  type: "not";
  matcher: ContextRuleMatcher;
};
declare function contextContains(searchString: string): {
  type: "jsonata";
  expression: string;
};
declare function hasTool(searchString: string): {
  type: "jsonata";
  expression: string;
};
declare function hasMCPConnection(searchString: string): {
  type: "jsonata";
  expression: string;
};
declare function forAgentClass(className: string): {
  type: "jsonata";
  expression: string;
};
declare function sandboxStatus(status: "starting" | "attached"): {
  type: "jsonata";
  expression: string;
};
declare function hasLabel(label: string): {
  type: "jsonata";
  expression: string;
};
declare const matchers: {
  never: typeof never;
  always: typeof always;
  jsonata: typeof jsonata;
  hasParticipant: typeof hasParticipant;
  slackChannel: typeof slackChannel;
  slackChannelHasExternalUsers: typeof slackChannelHasExternalUsers;
  contextContains: typeof contextContains;
  hasTool: typeof hasTool;
  hasMCPConnection: typeof hasMCPConnection;
  forAgentClass: typeof forAgentClass;
  sandboxStatus: typeof sandboxStatus;
  hasLabel: typeof hasLabel;
  and: typeof and;
  or: typeof or;
  not: typeof not;
  timeWindow: typeof timeWindow;
};
declare const defineRule: <Rule extends ContextRule>(rule: Rule) => Rule;
declare const defineRules: <Rules extends ContextRule[]>(rules: Rules) => Rules;
declare function timeWindow(windows: TimeWindow | TimeWindow[], opts?: {
  tz?: string;
}): {
  readonly type: "timeWindow";
  readonly windows: {
    weekdays?: (number | "MO" | "TU" | "WE" | "TH" | "FR" | "SA" | "SU")[] | undefined;
    months?: (number | "JAN" | "FEB" | "MAR" | "APR" | "MAY" | "JUN" | "JUL" | "AUG" | "SEP" | "OCT" | "NOV" | "DEC")[] | undefined;
    daysOfMonth?: number[] | undefined;
    timeOfDay?: {
      start: string;
      end: string;
    } | undefined;
    exact?: {
      month: number;
      day: number;
      hour: number;
      minute: number;
    } | undefined;
  }[];
  readonly tz: string | undefined;
};
/**
 * Parses front matter from a file content string.
 * Front matter is delimited by triple dashes (---) at the start of the file.
 * Returns the parsed front matter object and the remaining content.
 * The match field is automatically converted: strings become jsonata expressions,
 * objects are treated as ContextRuleMatcher directly.
 */

/**
 * Helper function to create context rules from files matching a glob pattern.
 * Each file becomes a context rule with slug derived from filename and prompt from file content.
 * Supports YAML front matter for overriding context rule properties.
 */
declare function contextRulesFromFiles(pattern: string, overrides?: Partial<ContextRule>): {
  key: string;
  description?: string | undefined;
  prompt: PromptFragment;
  tools?: ({
    type: "agent_durable_object_tool";
    methodName: string;
    passThroughArgs?: Record<string, JSONSerializable> | null | undefined;
    overrideName?: string | null | undefined;
    overrideDescription?: string | null | undefined;
    overrideInputJSONSchema?: any;
    strict?: boolean | undefined;
    triggerLLMRequest?: boolean | undefined;
    hideOptionalInputs?: boolean | undefined;
    statusIndicatorText?: string | null | undefined;
  } | {
    type: "openai_builtin";
    openAITool: {
      type: "file_search";
      vector_store_ids: string[];
      filters?: any;
      max_num_results?: number | undefined;
      ranking_options?: any;
    } | {
      type: "web_search" | "web_search_2025_08_26";
      search_context_size?: "low" | "medium" | "high" | undefined;
      user_location?: {
        type: "approximate";
        city?: string | null | undefined;
        country?: string | null | undefined;
        region?: string | null | undefined;
        timezone?: string | null | undefined;
      } | null | undefined;
    } | {
      type: "computer_use_preview";
      display_height: number;
      display_width: number;
      environment: "windows" | "mac" | "linux" | "ubuntu" | "browser";
    } | {
      type: "mcp";
      server_label: string;
      server_url?: string | undefined;
      allowed_tools?: string[] | {
        tool_names?: string[] | undefined;
      } | null | undefined;
      headers?: Record<string, string> | null | undefined;
      require_approval?: "never" | "always" | {
        always?: {
          tool_names?: string[] | undefined;
        } | undefined;
        never?: {
          tool_names?: string[] | undefined;
        } | undefined;
      } | null | undefined;
    } | {
      type: "code_interpreter";
      container: string | {
        type: "auto";
        file_ids?: string[] | undefined;
      };
    } | {
      type: "image_generation";
      background?: "auto" | "transparent" | "opaque" | undefined;
      input_image_mask?: {
        file_id?: string | undefined;
        image_url?: string | undefined;
      } | undefined;
      model?: "gpt-image-1" | undefined;
      moderation?: "low" | "auto" | undefined;
      output_compression?: number | undefined;
      output_format?: "png" | "webp" | "jpeg" | undefined;
      partial_images?: number | undefined;
      quality?: "low" | "medium" | "high" | "auto" | undefined;
      size?: "auto" | "1024x1024" | "1024x1536" | "1536x1024" | undefined;
    } | {
      type: "local_shell";
    };
    triggerLLMRequest?: boolean | undefined;
    hideOptionalInputs?: boolean | undefined;
  })[] | undefined;
  match?: (ContextRuleMatcher | ContextRuleMatcher[]) | undefined;
}[];
//#endregion
//#region sdk/iterate-config.d.ts
type IterateConfig = {
  contextRules?: ContextRule[];
};
declare function defineConfig(config: IterateConfig): IterateConfig;
//#endregion
//#region sdk/index.d.ts
declare const tools: {
  sendSlackMessage: (toolSpec?: (Omit<{
    type: "agent_durable_object_tool";
    methodName: string;
    passThroughArgs?: Record<string, JSONSerializable> | null | undefined;
    overrideName?: string | null | undefined;
    overrideDescription?: string | null | undefined;
    overrideInputJSONSchema?: any;
    strict?: boolean | undefined;
    triggerLLMRequest?: boolean | undefined;
    hideOptionalInputs?: boolean | undefined;
    statusIndicatorText?: string | null | undefined;
  }, "type" | "methodName" | "passThroughArgs"> & {
    passThroughArgs?: Partial<{
      text: string;
      blocks?: Record<string, any>[] | undefined;
      ephemeral?: boolean | undefined;
      user?: string | undefined;
      metadata?: {
        event_type: string;
        event_payload: any;
      } | undefined;
      modalDefinitions?: Record<string, any> | undefined;
      unfurl?: "never" | "auto" | "all" | undefined;
      endTurn?: boolean | undefined;
    }> | undefined;
  }) | undefined) => ToolSpec;
  addSlackReaction: (toolSpec?: (Omit<{
    type: "agent_durable_object_tool";
    methodName: string;
    passThroughArgs?: Record<string, JSONSerializable> | null | undefined;
    overrideName?: string | null | undefined;
    overrideDescription?: string | null | undefined;
    overrideInputJSONSchema?: any;
    strict?: boolean | undefined;
    triggerLLMRequest?: boolean | undefined;
    hideOptionalInputs?: boolean | undefined;
    statusIndicatorText?: string | null | undefined;
  }, "type" | "methodName" | "passThroughArgs"> & {
    passThroughArgs?: Partial<{
      messageTs: string;
      name: string;
    }> | undefined;
  }) | undefined) => ToolSpec;
  removeSlackReaction: (toolSpec?: (Omit<{
    type: "agent_durable_object_tool";
    methodName: string;
    passThroughArgs?: Record<string, JSONSerializable> | null | undefined;
    overrideName?: string | null | undefined;
    overrideDescription?: string | null | undefined;
    overrideInputJSONSchema?: any;
    strict?: boolean | undefined;
    triggerLLMRequest?: boolean | undefined;
    hideOptionalInputs?: boolean | undefined;
    statusIndicatorText?: string | null | undefined;
  }, "type" | "methodName" | "passThroughArgs"> & {
    passThroughArgs?: Partial<{
      messageTs: string;
      name: string;
    }> | undefined;
  }) | undefined) => ToolSpec;
  updateSlackMessage: (toolSpec?: (Omit<{
    type: "agent_durable_object_tool";
    methodName: string;
    passThroughArgs?: Record<string, JSONSerializable> | null | undefined;
    overrideName?: string | null | undefined;
    overrideDescription?: string | null | undefined;
    overrideInputJSONSchema?: any;
    strict?: boolean | undefined;
    triggerLLMRequest?: boolean | undefined;
    hideOptionalInputs?: boolean | undefined;
    statusIndicatorText?: string | null | undefined;
  }, "type" | "methodName" | "passThroughArgs"> & {
    passThroughArgs?: Partial<{
      ts: string;
      text?: string | undefined;
    }> | undefined;
  }) | undefined) => ToolSpec;
  stopRespondingUntilMentioned: (toolSpec?: (Omit<{
    type: "agent_durable_object_tool";
    methodName: string;
    passThroughArgs?: Record<string, JSONSerializable> | null | undefined;
    overrideName?: string | null | undefined;
    overrideDescription?: string | null | undefined;
    overrideInputJSONSchema?: any;
    strict?: boolean | undefined;
    triggerLLMRequest?: boolean | undefined;
    hideOptionalInputs?: boolean | undefined;
    statusIndicatorText?: string | null | undefined;
  }, "type" | "methodName" | "passThroughArgs"> & {
    passThroughArgs?: Partial<{
      reason: string;
    }> | undefined;
  }) | undefined) => ToolSpec;
  uploadAndShareFileInSlack: (toolSpec?: (Omit<{
    type: "agent_durable_object_tool";
    methodName: string;
    passThroughArgs?: Record<string, JSONSerializable> | null | undefined;
    overrideName?: string | null | undefined;
    overrideDescription?: string | null | undefined;
    overrideInputJSONSchema?: any;
    strict?: boolean | undefined;
    triggerLLMRequest?: boolean | undefined;
    hideOptionalInputs?: boolean | undefined;
    statusIndicatorText?: string | null | undefined;
  }, "type" | "methodName" | "passThroughArgs"> & {
    passThroughArgs?: Partial<{
      iterateFileId: string;
    }> | undefined;
  }) | undefined) => ToolSpec;
  $infer: (toolSpec?: (Omit<{
    type: "agent_durable_object_tool";
    methodName: string;
    passThroughArgs?: Record<string, JSONSerializable> | null | undefined;
    overrideName?: string | null | undefined;
    overrideDescription?: string | null | undefined;
    overrideInputJSONSchema?: any;
    strict?: boolean | undefined;
    triggerLLMRequest?: boolean | undefined;
    hideOptionalInputs?: boolean | undefined;
    statusIndicatorText?: string | null | undefined;
  }, "type" | "methodName" | "passThroughArgs"> & {
    passThroughArgs?: Partial<unknown> | undefined;
  }) | undefined) => ToolSpec;
  ping: (toolSpec?: (Omit<{
    type: "agent_durable_object_tool";
    methodName: string;
    passThroughArgs?: Record<string, JSONSerializable> | null | undefined;
    overrideName?: string | null | undefined;
    overrideDescription?: string | null | undefined;
    overrideInputJSONSchema?: any;
    strict?: boolean | undefined;
    triggerLLMRequest?: boolean | undefined;
    hideOptionalInputs?: boolean | undefined;
    statusIndicatorText?: string | null | undefined;
  }, "type" | "methodName" | "passThroughArgs"> & {
    passThroughArgs?: Partial<unknown> | undefined;
  }) | undefined) => ToolSpec;
  flexibleTestTool: (toolSpec?: (Omit<{
    type: "agent_durable_object_tool";
    methodName: string;
    passThroughArgs?: Record<string, JSONSerializable> | null | undefined;
    overrideName?: string | null | undefined;
    overrideDescription?: string | null | undefined;
    overrideInputJSONSchema?: any;
    strict?: boolean | undefined;
    triggerLLMRequest?: boolean | undefined;
    hideOptionalInputs?: boolean | undefined;
    statusIndicatorText?: string | null | undefined;
  }, "type" | "methodName" | "passThroughArgs"> & {
    passThroughArgs?: Partial<{
      params: {
        behaviour: "slow-tool";
        recordStartTime: boolean;
        delay: number;
        response: string;
      } | {
        behaviour: "raise-error";
        error: string;
      } | {
        behaviour: "return-secret";
        secret: string;
      };
    }> | undefined;
  }) | undefined) => ToolSpec;
  reverse: (toolSpec?: (Omit<{
    type: "agent_durable_object_tool";
    methodName: string;
    passThroughArgs?: Record<string, JSONSerializable> | null | undefined;
    overrideName?: string | null | undefined;
    overrideDescription?: string | null | undefined;
    overrideInputJSONSchema?: any;
    strict?: boolean | undefined;
    triggerLLMRequest?: boolean | undefined;
    hideOptionalInputs?: boolean | undefined;
    statusIndicatorText?: string | null | undefined;
  }, "type" | "methodName" | "passThroughArgs"> & {
    passThroughArgs?: Partial<{
      message: string;
    }> | undefined;
  }) | undefined) => ToolSpec;
  doNothing: (toolSpec?: (Omit<{
    type: "agent_durable_object_tool";
    methodName: string;
    passThroughArgs?: Record<string, JSONSerializable> | null | undefined;
    overrideName?: string | null | undefined;
    overrideDescription?: string | null | undefined;
    overrideInputJSONSchema?: any;
    strict?: boolean | undefined;
    triggerLLMRequest?: boolean | undefined;
    hideOptionalInputs?: boolean | undefined;
    statusIndicatorText?: string | null | undefined;
  }, "type" | "methodName" | "passThroughArgs"> & {
    passThroughArgs?: Partial<{
      reason: string;
    }> | undefined;
  }) | undefined) => ToolSpec;
  getAgentDebugURL: (toolSpec?: (Omit<{
    type: "agent_durable_object_tool";
    methodName: string;
    passThroughArgs?: Record<string, JSONSerializable> | null | undefined;
    overrideName?: string | null | undefined;
    overrideDescription?: string | null | undefined;
    overrideInputJSONSchema?: any;
    strict?: boolean | undefined;
    triggerLLMRequest?: boolean | undefined;
    hideOptionalInputs?: boolean | undefined;
    statusIndicatorText?: string | null | undefined;
  }, "type" | "methodName" | "passThroughArgs"> & {
    passThroughArgs?: Partial<unknown> | undefined;
  }) | undefined) => ToolSpec;
  remindMyselfLater: (toolSpec?: (Omit<{
    type: "agent_durable_object_tool";
    methodName: string;
    passThroughArgs?: Record<string, JSONSerializable> | null | undefined;
    overrideName?: string | null | undefined;
    overrideDescription?: string | null | undefined;
    overrideInputJSONSchema?: any;
    strict?: boolean | undefined;
    triggerLLMRequest?: boolean | undefined;
    hideOptionalInputs?: boolean | undefined;
    statusIndicatorText?: string | null | undefined;
  }, "type" | "methodName" | "passThroughArgs"> & {
    passThroughArgs?: Partial<{
      message: string;
      type: "numberOfSecondsFromNow" | "atSpecificDateAndTime" | "recurringCron";
      when: string;
    }> | undefined;
  }) | undefined) => ToolSpec;
  listMyReminders: (toolSpec?: (Omit<{
    type: "agent_durable_object_tool";
    methodName: string;
    passThroughArgs?: Record<string, JSONSerializable> | null | undefined;
    overrideName?: string | null | undefined;
    overrideDescription?: string | null | undefined;
    overrideInputJSONSchema?: any;
    strict?: boolean | undefined;
    triggerLLMRequest?: boolean | undefined;
    hideOptionalInputs?: boolean | undefined;
    statusIndicatorText?: string | null | undefined;
  }, "type" | "methodName" | "passThroughArgs"> & {
    passThroughArgs?: Partial<Record<string, never>> | undefined;
  }) | undefined) => ToolSpec;
  cancelReminder: (toolSpec?: (Omit<{
    type: "agent_durable_object_tool";
    methodName: string;
    passThroughArgs?: Record<string, JSONSerializable> | null | undefined;
    overrideName?: string | null | undefined;
    overrideDescription?: string | null | undefined;
    overrideInputJSONSchema?: any;
    strict?: boolean | undefined;
    triggerLLMRequest?: boolean | undefined;
    hideOptionalInputs?: boolean | undefined;
    statusIndicatorText?: string | null | undefined;
  }, "type" | "methodName" | "passThroughArgs"> & {
    passThroughArgs?: Partial<{
      iterateReminderId: string;
    }> | undefined;
  }) | undefined) => ToolSpec;
  connectMCPServer: (toolSpec?: (Omit<{
    type: "agent_durable_object_tool";
    methodName: string;
    passThroughArgs?: Record<string, JSONSerializable> | null | undefined;
    overrideName?: string | null | undefined;
    overrideDescription?: string | null | undefined;
    overrideInputJSONSchema?: any;
    strict?: boolean | undefined;
    triggerLLMRequest?: boolean | undefined;
    hideOptionalInputs?: boolean | undefined;
    statusIndicatorText?: string | null | undefined;
  }, "type" | "methodName" | "passThroughArgs"> & {
    passThroughArgs?: Partial<{
      serverUrl: string;
      mode: "personal" | "company";
      requiresHeadersAuth: Record<string, {
        description: string;
        placeholder: string;
        sensitive: boolean;
      }> | null;
      requiresQueryParamsAuth: Record<string, {
        description: string;
        placeholder: string;
        sensitive: boolean;
      }> | null;
      onBehalfOfIterateUserId: string;
    }> | undefined;
  }) | undefined) => ToolSpec;
  getURLContent: (toolSpec?: (Omit<{
    type: "agent_durable_object_tool";
    methodName: string;
    passThroughArgs?: Record<string, JSONSerializable> | null | undefined;
    overrideName?: string | null | undefined;
    overrideDescription?: string | null | undefined;
    overrideInputJSONSchema?: any;
    strict?: boolean | undefined;
    triggerLLMRequest?: boolean | undefined;
    hideOptionalInputs?: boolean | undefined;
    statusIndicatorText?: string | null | undefined;
  }, "type" | "methodName" | "passThroughArgs"> & {
    passThroughArgs?: Partial<{
      url: string;
      includeScreenshotOfPage?: boolean | undefined;
      includeTextContent?: boolean | undefined;
    }> | undefined;
  }) | undefined) => ToolSpec;
  searchWeb: (toolSpec?: (Omit<{
    type: "agent_durable_object_tool";
    methodName: string;
    passThroughArgs?: Record<string, JSONSerializable> | null | undefined;
    overrideName?: string | null | undefined;
    overrideDescription?: string | null | undefined;
    overrideInputJSONSchema?: any;
    strict?: boolean | undefined;
    triggerLLMRequest?: boolean | undefined;
    hideOptionalInputs?: boolean | undefined;
    statusIndicatorText?: string | null | undefined;
  }, "type" | "methodName" | "passThroughArgs"> & {
    passThroughArgs?: Partial<{
      query: string;
      numResults: number;
    }> | undefined;
  }) | undefined) => ToolSpec;
  generateImage: (toolSpec?: (Omit<{
    type: "agent_durable_object_tool";
    methodName: string;
    passThroughArgs?: Record<string, JSONSerializable> | null | undefined;
    overrideName?: string | null | undefined;
    overrideDescription?: string | null | undefined;
    overrideInputJSONSchema?: any;
    strict?: boolean | undefined;
    triggerLLMRequest?: boolean | undefined;
    hideOptionalInputs?: boolean | undefined;
    statusIndicatorText?: string | null | undefined;
  }, "type" | "methodName" | "passThroughArgs"> & {
    passThroughArgs?: Partial<{
      prompt: string;
      inputImages: string[];
      model: ${"`${string}/${string}` | `${string}/${string}:${string}`"};
      quality: "low" | "medium" | "high";
      background: "auto" | "transparent" | "opaque";
      overrideReplicateParams?: Record<string, any> | undefined;
    }> | undefined;
  }) | undefined) => ToolSpec;
  exec: (toolSpec?: (Omit<{
    type: "agent_durable_object_tool";
    methodName: string;
    passThroughArgs?: Record<string, JSONSerializable> | null | undefined;
    overrideName?: string | null | undefined;
    overrideDescription?: string | null | undefined;
    overrideInputJSONSchema?: any;
    strict?: boolean | undefined;
    triggerLLMRequest?: boolean | undefined;
    hideOptionalInputs?: boolean | undefined;
    statusIndicatorText?: string | null | undefined;
  }, "type" | "methodName" | "passThroughArgs"> & {
    passThroughArgs?: Partial<{
      command: string;
      files?: {
        path: string;
        content: string;
      }[] | undefined;
      env?: Record<string, string> | undefined;
    }> | undefined;
  }) | undefined) => ToolSpec;
  execCodex: (toolSpec?: (Omit<{
    type: "agent_durable_object_tool";
    methodName: string;
    passThroughArgs?: Record<string, JSONSerializable> | null | undefined;
    overrideName?: string | null | undefined;
    overrideDescription?: string | null | undefined;
    overrideInputJSONSchema?: any;
    strict?: boolean | undefined;
    triggerLLMRequest?: boolean | undefined;
    hideOptionalInputs?: boolean | undefined;
    statusIndicatorText?: string | null | undefined;
  }, "type" | "methodName" | "passThroughArgs"> & {
    passThroughArgs?: Partial<{
      command: string;
    }> | undefined;
  }) | undefined) => ToolSpec;
  generateVideo: (toolSpec?: (Omit<{
    type: "agent_durable_object_tool";
    methodName: string;
    passThroughArgs?: Record<string, JSONSerializable> | null | undefined;
    overrideName?: string | null | undefined;
    overrideDescription?: string | null | undefined;
    overrideInputJSONSchema?: any;
    strict?: boolean | undefined;
    triggerLLMRequest?: boolean | undefined;
    hideOptionalInputs?: boolean | undefined;
    statusIndicatorText?: string | null | undefined;
  }, "type" | "methodName" | "passThroughArgs"> & {
    passThroughArgs?: Partial<{
      prompt: string;
      model: "sora-2" | "sora-2-pro";
      seconds: "4" | "8" | "12";
      size: "720x1280" | "1280x720" | "1024x1792" | "1792x1024";
      inputReferenceFileId?: string | undefined;
    }> | undefined;
  }) | undefined) => ToolSpec;
  callGoogleAPI: (toolSpec?: (Omit<{
    type: "agent_durable_object_tool";
    methodName: string;
    passThroughArgs?: Record<string, JSONSerializable> | null | undefined;
    overrideName?: string | null | undefined;
    overrideDescription?: string | null | undefined;
    overrideInputJSONSchema?: any;
    strict?: boolean | undefined;
    triggerLLMRequest?: boolean | undefined;
    hideOptionalInputs?: boolean | undefined;
    statusIndicatorText?: string | null | undefined;
  }, "type" | "methodName" | "passThroughArgs"> & {
    passThroughArgs?: Partial<{
      endpoint: string;
      method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
      impersonateUserId: string;
      body?: any;
      queryParams?: Record<string, string> | undefined;
      pathParams?: Record<string, string> | undefined;
    }> | undefined;
  }) | undefined) => ToolSpec;
  sendGmail: (toolSpec?: (Omit<{
    type: "agent_durable_object_tool";
    methodName: string;
    passThroughArgs?: Record<string, JSONSerializable> | null | undefined;
    overrideName?: string | null | undefined;
    overrideDescription?: string | null | undefined;
    overrideInputJSONSchema?: any;
    strict?: boolean | undefined;
    triggerLLMRequest?: boolean | undefined;
    hideOptionalInputs?: boolean | undefined;
    statusIndicatorText?: string | null | undefined;
  }, "type" | "methodName" | "passThroughArgs"> & {
    passThroughArgs?: Partial<{
      to: string;
      subject: string;
      body: string;
      impersonateUserId: string;
      cc?: string | undefined;
      bcc?: string | undefined;
      threadId?: string | undefined;
      inReplyTo?: string | undefined;
    }> | undefined;
  }) | undefined) => ToolSpec;
  getGmailMessage: (toolSpec?: (Omit<{
    type: "agent_durable_object_tool";
    methodName: string;
    passThroughArgs?: Record<string, JSONSerializable> | null | undefined;
    overrideName?: string | null | undefined;
    overrideDescription?: string | null | undefined;
    overrideInputJSONSchema?: any;
    strict?: boolean | undefined;
    triggerLLMRequest?: boolean | undefined;
    hideOptionalInputs?: boolean | undefined;
    statusIndicatorText?: string | null | undefined;
  }, "type" | "methodName" | "passThroughArgs"> & {
    passThroughArgs?: Partial<{
      messageId: string;
      impersonateUserId: string;
    }> | undefined;
  }) | undefined) => ToolSpec;
  addLabel: (toolSpec?: (Omit<{
    type: "agent_durable_object_tool";
    methodName: string;
    passThroughArgs?: Record<string, JSONSerializable> | null | undefined;
    overrideName?: string | null | undefined;
    overrideDescription?: string | null | undefined;
    overrideInputJSONSchema?: any;
    strict?: boolean | undefined;
    triggerLLMRequest?: boolean | undefined;
    hideOptionalInputs?: boolean | undefined;
    statusIndicatorText?: string | null | undefined;
  }, "type" | "methodName" | "passThroughArgs"> & {
    passThroughArgs?: Partial<{
      label: string;
    }> | undefined;
  }) | undefined) => ToolSpec;
  messageAgent: (toolSpec?: (Omit<{
    type: "agent_durable_object_tool";
    methodName: string;
    passThroughArgs?: Record<string, JSONSerializable> | null | undefined;
    overrideName?: string | null | undefined;
    overrideDescription?: string | null | undefined;
    overrideInputJSONSchema?: any;
    strict?: boolean | undefined;
    triggerLLMRequest?: boolean | undefined;
    hideOptionalInputs?: boolean | undefined;
    statusIndicatorText?: string | null | undefined;
  }, "type" | "methodName" | "passThroughArgs"> & {
    passThroughArgs?: Partial<{
      agentName: string;
      message: string;
      triggerLLMRequest: boolean;
    }> | undefined;
  }) | undefined) => ToolSpec;
};
//#endregion
export { type ContextRule, type PromptFragment, type ToolSpec, contextRulesFromFiles, dedent, defineConfig, defineRule, defineRules, f, matchers, tools };
`;
