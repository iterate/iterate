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
  Upload,
  FilePlus,
  FolderPlus,
  Pencil,
  Trash2,
} from "lucide-react";
import { cn } from "../lib/utils.ts";
import { useTRPC } from "../lib/trpc.ts";
import { useEstateId } from "../hooks/use-estate.ts";
import { IterateLetterI } from "./ui/iterate-logos.tsx";
import { Button } from "./ui/button.tsx";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "./ui/context-menu.tsx";

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
function buildFileTree(filePaths: Array<[string, string | null]>): FileTreeNode[] {
  const root: FileTreeNode[] = [];
  const nodeMap = new Map<string, FileTreeNode>();

  // Filter out empty files and sort
  const validPaths = filePaths
    .filter(([path, value]) => path.trim() !== "" && typeof value === "string")
    .sort();

  for (const [path] of validPaths) {
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
  onNewFile: (folderPath: string) => void;
  onNewFolder: (folderPath: string) => void;
  onRename: (oldPath: string, newPath: string) => void;
  onDelete: (path: string) => void;
  level?: number;
}

function FileTreeView({
  nodes,
  selectedFile,
  onFileSelect,
  isFileEdited,
  collapsedFolders,
  onToggleFolder,
  onNewFile,
  onNewFolder,
  onRename,
  onDelete,
  level = 0,
}: FileTreeViewProps) {
  const [hoveredFolder, setHoveredFolder] = useState<string | null>(null);

  return (
    <>
      {nodes.map((node) => {
        const isCollapsed = collapsedFolders.has(node.path);
        const hasChildren = node.children && node.children.length > 0;
        const isHovered = hoveredFolder === node.path;

        return (
          <div key={node.path}>
            <ContextMenu>
              <ContextMenuTrigger asChild>
                <div
                  className="group relative"
                  onMouseEnter={() => node.type === "folder" && setHoveredFolder(node.path)}
                  onMouseLeave={() => node.type === "folder" && setHoveredFolder(null)}
                >
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
                    style={{ paddingLeft: `${level === 0 ? 2 : level * 12 + 8}px` }}
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
                  {node.type === "folder" && isHovered && (
                    <div className="absolute right-1 top-1 flex gap-0.5 bg-background/80 backdrop-blur-sm rounded">
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          onNewFile(node.path);
                        }}
                        className="p-0.5 hover:bg-accent rounded"
                        title="New File"
                      >
                        <FilePlus className="h-3 w-3" />
                      </button>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          onNewFolder(node.path);
                        }}
                        className="p-0.5 hover:bg-accent rounded"
                        title="New Folder"
                      >
                        <FolderPlus className="h-3 w-3" />
                      </button>
                    </div>
                  )}
                </div>
              </ContextMenuTrigger>
              <ContextMenuContent>
                <ContextMenuItem
                  onClick={() => {
                    const newName = prompt(`Rename ${node.type}:`, node.name);
                    if (newName && newName !== node.name) {
                      const parentPath = node.path.split("/").slice(0, -1).join("/");
                      const newPath = parentPath ? `${parentPath}/${newName}` : newName;
                      onRename(node.path, newPath);
                    }
                  }}
                >
                  <Pencil />
                  Rename
                </ContextMenuItem>
                <ContextMenuItem variant="destructive" onClick={() => onDelete(node.path)}>
                  <Trash2 />
                  Delete
                </ContextMenuItem>
              </ContextMenuContent>
            </ContextMenu>
            {node.type === "folder" && node.children && !isCollapsed && (
              <FileTreeView
                nodes={node.children}
                selectedFile={selectedFile}
                onFileSelect={onFileSelect}
                isFileEdited={isFileEdited}
                collapsedFolders={collapsedFolders}
                onToggleFolder={onToggleFolder}
                onNewFile={onNewFile}
                onNewFolder={onNewFolder}
                onRename={onRename}
                onDelete={onDelete}
                level={level + 1}
              />
            )}
          </div>
        );
      })}
    </>
  );
}

export function IDE() {
  const trpc = useTRPC();
  const estateId = useEstateId();

  const [selectedFile, setSelectedFile] = useSessionStorage<string | null>(
    "iterate-selected-file",
    null,
  );
  const [localEdits, setLocalEdits] = useSessionStorage<Record<string, string | null> | null>(
    "iterate-local-edits",
    {},
  );
  const [expectedEdits, setExpectedEdits] = useState({} as Record<string, string | null>);
  const [collapsedFoldersRecord, setCollapsedFolders] = useSessionStorage<Record<string, boolean>>(
    "iterate-collapsed-folders",
    {},
  );
  const collapsedFolders = useMemo(
    () =>
      new Set(Object.keys(collapsedFoldersRecord).filter((path) => collapsedFoldersRecord[path])),
    [collapsedFoldersRecord],
  );

  const [bump, setBump] = useState(0);
  const getRepoFilesystemQueryOptions = trpc.estate.getRepoFilesystem.queryOptions({
    estateId,
    ...({ bump } as {}),
  });

  const saveFileMutation = useMutation(
    trpc.estate.updateRepo.mutationOptions({
      onSuccess: (_data, variables) => {
        const edited = new Set([
          ...(variables.commit.fileChanges.additions?.map((addition) => addition.path) || []),
          ...(variables.commit.fileChanges.deletions?.map((deletion) => deletion.path) || []),
        ]);
        setBump((prev) => prev + 1);
        setExpectedEdits(localEdits || {});
        setLocalEdits(
          localEdits &&
            Object.fromEntries(Object.entries(localEdits).filter(([k]) => !edited.has(k))),
        );
      },
    }),
  );

  const getRepoFileSystemQuery = useQuery({
    ...getRepoFilesystemQueryOptions,
    placeholderData: (old) =>
      old && { ...old, filesystem: { ...old.filesystem, ...expectedEdits }, sha: "" },
  });

  const dts = useQuery({
    ...trpc.estate.getDTS.queryOptions({
      packageJson: JSON.parse(getRepoFileSystemQuery.data?.filesystem["package.json"] || "{}"),
    }),
    enabled: !!getRepoFileSystemQuery.data?.filesystem["package.json"],
  });
  const { filesystem, sha, repoData } = getRepoFileSystemQuery.data || {
    filesystem: {},
    sha: "",
    repoData: null,
  };
  const repoName = repoData?.full_name?.split("/")[1] || "repository";

  // Derive file contents by merging filesystem with local edits, excluding deleted files
  const fileContents = useMemo(() => {
    return { ...filesystem, ...localEdits };
  }, [filesystem, localEdits]);

  // Derive valid selected file (reset if file no longer exists)
  const validSelectedFile = useMemo(() => {
    if (selectedFile && selectedFile in fileContents) {
      return selectedFile;
    }
    if ("iterate.config.ts" in fileContents) {
      return "iterate.config.ts";
    }
    return null;
  }, [selectedFile, fileContents]);

  // Build file tree from filesystem and wrap in root folder
  const fileTree = useMemo(() => {
    const tree = buildFileTree(Object.entries(fileContents));
    // Wrap in root folder based on repo name
    return [
      {
        name: repoName,
        path: "",
        type: "folder" as const,
        children: tree,
      },
    ];
  }, [fileContents, repoName]);
  const currentContent = validSelectedFile ? fileContents[validSelectedFile] : "";

  const handleToggleFolder = (path: string) => {
    setCollapsedFolders((prev) => ({ ...prev, [path]: !prev[path] }));
  };

  const handleNewFile = (folderPath: string) => {
    const fileName = prompt("Enter file name:");
    if (!fileName) return;

    const fullPath = folderPath ? `${folderPath}/${fileName}` : fileName;
    setLocalEdits((prev) => ({
      ...prev,
      [fullPath]: "",
    }));
    setSelectedFile(fullPath);
    // Expand the folder if it's collapsed
    if (folderPath && collapsedFolders.has(folderPath)) {
      handleToggleFolder(folderPath);
    }
  };

  const handleNewFolder = (parentPath: string) => {
    const folderName = prompt("Enter folder name:");
    if (!folderName) return;

    const fullPath = parentPath ? `${parentPath}/${folderName}` : folderName;
    // Create a placeholder file in the folder to make it appear
    const placeholderPath = `${fullPath}/.gitkeep`;
    setLocalEdits((prev) => ({
      ...prev,
      [placeholderPath]: "",
    }));
    // Expand parent folder
    if (parentPath && collapsedFolders.has(parentPath)) {
      handleToggleFolder(parentPath);
    }
  };

  const handleRename = (oldPath: string, newPath: string) => {
    if (oldPath === newPath) return;
    setLocalEdits((prev) => ({
      [newPath]: prev?.[oldPath] ?? null,
      [oldPath]: null,
    }));
    if (validSelectedFile === oldPath) setSelectedFile(newPath);
  };

  const handleDelete = (path: string) => {
    if (!confirm(`Are you sure you want to delete ${path}?`)) return;

    setLocalEdits((prev) => {
      const updated = { ...prev };
      updated[path] = null;
      for (const otherpath of Object.keys(filesystem)) {
        if (otherpath.startsWith(path + "/")) {
          updated[otherpath] = null;
        }
      }
      return updated;
    });
    // Clear selection if deleted file was selected
    if (validSelectedFile === path || validSelectedFile?.startsWith(path + "/")) {
      setSelectedFile(null);
    }
  };

  // Check if a file has been edited
  const isFileEdited = (filename: string): boolean => {
    return fileContents[filename] !== (filesystem as Record<string, string>)[filename];
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
    console.log("handleSave", { validSelectedFile });
    if (validSelectedFile) handleSaveAll([validSelectedFile]);
  };

  const handleSaveAll = (filepaths = Object.keys(fileContents)) => {
    const additions: { path: string; contents: string }[] = [];
    const deletions: { path: string }[] = [];
    filepaths.forEach((filename) => {
      if (isFileEdited(filename)) {
        const content = fileContents[filename];
        // If content is null
        if (content === null) {
          deletions.push({ path: filename });
        } else {
          additions.push({ path: filename, contents: content });
        }
      }
    });
    const summarise = (label: string, list: { path: string }[]) => {
      if (list.length === 0) return "";
      if (list.length === 1) return `${label}: ${list[0].path}`;
      return `${list.length} ${label}s`;
    };
    const summary = [summarise("addition", additions), summarise("deletion", deletions)]
      .filter(Boolean)
      .join(" and ");

    saveFileMutation.mutate({
      estateId,
      commit: {
        expectedHeadOid: sha,
        message: {
          headline: `in-browser changes: ${summary}`,
        },
        fileChanges: { additions, deletions },
      },
      format: "plaintext",
    });
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

  const _getEditor = () => editorRef.current?.[0];
  const getMonaco = () => editorRef.current?.[1];

  // useEffect(() => {
  //   const monaco = _getMonaco();
  //   if (!monaco) return;

  //   const tsconfig = JSON5.parse(getRepoFileSystemQuery.data?.filesystem["tsconfig.json"] || "{}");
  //   const compilerOptions = tsconfig.compilerOptions || {};
  //   monaco.languages.typescript.typescriptDefaults.setCompilerOptions({
  //     ...monaco.languages.typescript.typescriptDefaults.getCompilerOptions(),
  //     strict: false,
  //     ...compilerOptions,
  //     typeRoots: [...(compilerOptions.typeRoots || []), "file:///node_modules"],
  //   });
  // }, [getRepoFileSystemQuery.data]);
  useEffect(() => {
    const monaco = getMonaco();
    if (!monaco) return;
    dts.data?.forEach((p) => {
      Object.entries(p.files).forEach(([filename, content]) => {
        monaco.languages.typescript.typescriptDefaults.addExtraLib(
          content,
          `file:///node_modules/${p.packageJson.name}/${filename}`,
        );
      });
    });
  }, [dts.data, validSelectedFile]);

  useEffect(() => {
    const monaco = getMonaco();
    if (!monaco) return;
    if (!getRepoFileSystemQuery.data) return;
    Object.entries(getRepoFileSystemQuery.data.filesystem).forEach(([filename, content]) => {
      if (content && (filename.endsWith(".ts") || filename.endsWith(".tsx"))) {
        console.log("adding extra lib", filename);
        monaco.languages.typescript.typescriptDefaults.addExtraLib(
          content,
          `inmemory://model/${filename}`,
        );
        monaco.languages.typescript.typescriptDefaults.addExtraLib(
          content,
          `file:///app/${filename}`,
        );
      }
    });
    // monaco.languages.typescript.typescriptDefaults.setCompilerOptions({
    //   ...monaco.languages.typescript.typescriptDefaults.getCompilerOptions(),
    //   typeRoots: ["file:///node_modules"],
    // });
  }, [getRepoFileSystemQuery.data]);

  const { resolvedTheme } = useTheme();

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
    <div className="flex h-[calc(100vh-8rem)] overflow-hidden">
      {/* Left sidebar - File tree */}
      <div className="w-48 flex-shrink-0 border-r bg-muted/30 overflow-y-auto flex flex-col">
        <div className="p-2 border-b">
          <Button
            onClick={handleSave}
            disabled={
              !hasUnsavedChanges || saveFileMutation.isPending || getRepoFileSystemQuery.isPending
            }
            size="sm"
            variant="ghost"
            className="w-full h-7 text-xs gap-1.5"
          >
            <Upload className="h-3 w-3" />
            {saveFileMutation.isPending || getRepoFileSystemQuery.isPending
              ? "Pushing..."
              : "Push to GitHub"}
          </Button>
        </div>
        <div className="p-2 border-b">
          <Button
            onClick={() => handleSaveAll()}
            disabled={
              Object.keys(localEdits || {}).length === 0 ||
              saveFileMutation.isPending ||
              getRepoFileSystemQuery.isPending
            }
            size="sm"
            variant="ghost"
            className="w-full h-7 text-xs gap-1.5"
          >
            <Upload className="h-3 w-3" />
            Push all
          </Button>
        </div>
        <div className="p-2 flex-1 overflow-y-auto">
          <FileTreeView
            nodes={fileTree}
            selectedFile={validSelectedFile}
            onFileSelect={setSelectedFile}
            isFileEdited={isFileEdited}
            collapsedFolders={collapsedFolders}
            onToggleFolder={handleToggleFolder}
            onNewFile={handleNewFile}
            onNewFolder={handleNewFolder}
            onRename={handleRename}
            onDelete={handleDelete}
          />
        </div>
      </div>

      {/* Main panel - Editor */}
      <div className="flex-1 min-w-0">
        {validSelectedFile ? (
          <Editor
            path={validSelectedFile ? `file:///app/${validSelectedFile}` : undefined}
            height="100%"
            defaultLanguage={language || "markdown"}
            language={language}
            onChange={(val) => handleContentChange(val || "")}
            value={currentContent || ""}
            theme={resolvedTheme === "dark" ? "vs-dark" : "light"}
            options={{ wordWrap: "on", fixedOverflowWidgets: true }}
            beforeMount={(monaco) => {
              const tsconfig = JSON.parse(
                getRepoFileSystemQuery.data?.filesystem["tsconfig.json"] || "{}",
              ) as import("type-fest").TsConfigJson;
              const {
                // stupid monaco demands enum values and won't accept perfectly good strings
                jsx,
                module,
                moduleResolution,
                newLine,
                target,
                plugins,
                ...compilerOptions
              } = tsconfig.compilerOptions || {};
              monaco.languages.typescript.JsxEmit.Preserve;
              monaco.languages.typescript.typescriptDefaults.setCompilerOptions({
                ...monaco.languages.typescript.typescriptDefaults.getCompilerOptions(),
                ...compilerOptions,
                strict: false,
                lib: ["es6", "DOM"],
                allowJs: true,
                allowImportingTsExtensions: true,
                allowSyntheticDefaultImports: true,
                // verbatimModuleSyntax: false, // causes problems with our fake node_modules
                typeRoots: ["file:///node_modules"],
              });
            }}
            onMount={onMount}
          />
        ) : (
          <div className="flex items-center justify-center h-full text-muted-foreground">
            Select a file to edit
          </div>
        )}
      </div>
    </div>
  );
}
