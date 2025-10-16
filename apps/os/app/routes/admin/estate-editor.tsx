import { useSessionStorage } from "usehooks-ts";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useState, useEffect, useRef, useMemo } from "react";
import { basicSetup, EditorView } from "codemirror";
import { javascript } from "@codemirror/lang-javascript";
import { markdown } from "@codemirror/lang-markdown";
import { search, searchKeymap } from "@codemirror/search";
import { keymap } from "@codemirror/view";
import { vsCodeDark, vsCodeLight } from "@fsegurai/codemirror-theme-bundle";
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

interface CodeEditorProps {
  value: string;
  onChange: (value: string) => void;
  language: "typescript" | "markdown";
}

function CodeEditor({ value, onChange, language }: CodeEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const { resolvedTheme } = useTheme();

  useEffect(() => {
    if (!containerRef.current) {
      return;
    }

    viewRef.current?.destroy();

    const lang = language === "typescript" ? javascript({ typescript: true }) : markdown();
    const codeMirrorTheme = resolvedTheme === "dark" ? vsCodeDark : vsCodeLight;

    const view = new EditorView({
      doc: value,
      extensions: [
        basicSetup,
        codeMirrorTheme,
        lang,
        search({ top: true }),
        keymap.of(searchKeymap),
        EditorView.lineWrapping,
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            onChange(update.state.doc.toString());
          }
        }),
        EditorView.contentAttributes.of({ tabindex: "0" }),
      ],
      parent: containerRef.current,
    });

    viewRef.current = view;

    return () => {
      viewRef.current?.destroy();
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- value and onChange excluded to avoid recreating editor on every change
  }, [language, resolvedTheme]);

  // Update document when value changes externally
  useEffect(() => {
    if (viewRef.current && viewRef.current.state.doc.toString() !== value) {
      viewRef.current.dispatch({
        changes: { from: 0, to: viewRef.current.state.doc.length, insert: value },
      });
    }
  }, [value]);

  return <div ref={containerRef} className="h-full overflow-auto" />;
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

  const getLanguage = (filename: string): "typescript" | "markdown" => {
    if (filename.endsWith(".md")) return "markdown";
    return "typescript";
  };

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
            <div className="flex-1 overflow-hidden">
              <CodeEditor
                value={currentContent}
                onChange={handleContentChange}
                language={getLanguage(validSelectedFile)}
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
