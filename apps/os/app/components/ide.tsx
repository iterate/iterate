import { toast } from "sonner";
import Editor, { DiffEditor } from "@monaco-editor/react";
import type { OnMount } from "@monaco-editor/react";
import { useSessionStorage, useLocalStorage } from "usehooks-ts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, useEffect, useRef, useMemo, useCallback, useImperativeHandle } from "react";
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
  GitPullRequest,
  GitMerge,
  X,
  Plus,
  GitCompare,
  FileEdit,
  AlertTriangle,
} from "lucide-react";
import { formatDate } from "date-fns";
import { useQueryState } from "nuqs";
import { cn } from "../lib/utils.ts";
import { useTRPC } from "../lib/trpc.ts";
import { useInstallationId } from "../hooks/use-installation.ts";
import { IterateLetterI } from "./ui/iterate-logos.tsx";
import { Button } from "./ui/button.tsx";
import { Spinner } from "./ui/spinner.tsx";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "./ui/context-menu.tsx";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "./ui/alert-dialog.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog.tsx";
import { Input } from "./ui/input.tsx";
import { Switch } from "./ui/switch.tsx";
import { Label } from "./ui/label.tsx";

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
    return <IterateLetterI className="h-3 w-3 shrink-0" />;
  }

  if (filename === ".gitignore") {
    return <span className="text-xs">🙈</span>;
  }

  const extension = filename.split(".").pop()?.toLowerCase();

  switch (extension) {
    case "md":
    case "markdown":
      return <FileText className="h-3 w-3 shrink-0 text-blue-500" />;
    case "ts":
    case "tsx":
      return <FileCode className="h-3 w-3 shrink-0 text-blue-600" />;
    case "js":
    case "jsx":
      return <FileCode className="h-3 w-3 shrink-0 text-yellow-500" />;
    case "json":
      return <FileJson className="h-3 w-3 shrink-0 text-yellow-600" />;
    case "yaml":
    case "yml":
      return <Braces className="h-3 w-3 shrink-0 text-purple-500" />;
    case "toml":
      return <Settings className="h-3 w-3 shrink-0 text-gray-500" />;
    default:
      return <File className="h-3 w-3 shrink-0" />;
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
  onNewFile: (params?: { folderPath?: string; fileName?: string; contents?: string }) => void;
  onNewFolder: (folderPath: string) => void;
  onRename: (oldPath: string, newPath: string) => void;
  onRenameOpen: (path: string, name: string, type: "file" | "folder") => void;
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
  onRenameOpen,
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
                            <ChevronRight className="h-3 w-3 shrink-0" />
                          ) : (
                            <ChevronDown className="h-3 w-3 shrink-0" />
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
                          onNewFile({ folderPath: node.path });
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
                    onRenameOpen(node.path, node.name, node.type);
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
                onRenameOpen={onRenameOpen}
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

type LocalEditsUpdater = (edits: Record<string, string | null>) => { branch: string };

export type IDEHandle = {
  updateLocalEdits: LocalEditsUpdater;
};

export function IDE({ ref }: { ref: React.RefObject<IDEHandle | null> }) {
  const trpc = useTRPC();
  const installationId = useInstallationId();

  const [selectedFile, setSelectedFile] = useQueryState("file", { defaultValue: "" });

  const [mode, setMode] = useLocalStorage<"yolo" | "pr">("iterate-repo-editing-mode", "yolo");
  const yoloMode = mode === "yolo";

  const [viewMode, setViewMode] = useLocalStorage<"edit" | "diff" | "readonly">(
    "iterate-ide-view-mode",
    "edit",
  );

  const [currentPrBranch, setCurrentPrBranch, removeCurrentPrBranch] = useLocalStorage<string>(
    "iterate-pr-branch",
    () => `ide/${formatDate(new Date(), "yyyy-MM-dd-HH-mm-ss")}`,
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

  const queryClient = useQueryClient();

  const getRepoFilesystemQueryOptions = useMemo(
    () =>
      trpc.installation.getRepoFilesystem.queryOptions({
        installationId,
        branch: yoloMode ? undefined : currentPrBranch,
      }),
    [trpc, installationId, currentPrBranch, yoloMode],
  );

  const getRepoFileSystemQuery = useQuery({
    ...getRepoFilesystemQueryOptions,
    enabled: yoloMode || !!currentPrBranch,
  });

  const {
    filesystem: filesFromRepo,
    sha,
    repoData,
    branchExists = true,
    branch: actualBranch,
    defaultBranch,
  } = (getRepoFileSystemQuery.isSuccess && getRepoFileSystemQuery.data) || {
    filesystem: {},
    sha: "",
    repoData: null,
    branchExists: true,
    requestedBranch: yoloMode ? undefined : currentPrBranch,
    branch: yoloMode ? undefined : currentPrBranch,
    defaultBranch: undefined,
  };
  const repoName = repoData?.full_name?.split("/")[1] || "repository";

  // Determine which branch we're pushing to
  // In yolo mode, always push to defaultBranch; otherwise use currentPrBranch
  const pushToBranch = useMemo(() => {
    if (yoloMode && defaultBranch) {
      return defaultBranch;
    }
    return currentPrBranch || defaultBranch || "main";
  }, [yoloMode, defaultBranch, currentPrBranch]);

  // Use localStorage for per-branch local edits based on pushToBranch
  const [localEdits, setLocalEdits] = useLocalStorage<Record<string, string | null>>(
    `iterate-ide-local-edits-${installationId}`,
    {},
  );

  const containerRef = useRef<HTMLDivElement>(null);

  // Expose updateLocalEdits via imperative handle
  useImperativeHandle(
    ref,
    () => ({
      updateLocalEdits: (edits) => {
        setLocalEdits(edits);
        setViewMode("diff");
        requestAnimationFrame(() => containerRef.current?.scrollIntoView({ behavior: "smooth" }));
        return { branch: pushToBranch };
      },
    }),
    [setLocalEdits, setViewMode, pushToBranch, containerRef],
  );

  const updateRepoMutation = useMutation(
    trpc.installation.updateRepo.mutationOptions({
      onSuccess: () => {
        // Invalidate and refetch the repo filesystem query
        queryClient.invalidateQueries(
          trpc.installation.getRepoFilesystem.queryFilter({
            installationId,
            branch: yoloMode ? undefined : currentPrBranch,
          }),
        );
        // Also invalidate for pushToBranch if different
        if (pushToBranch && pushToBranch !== currentPrBranch) {
          queryClient.invalidateQueries(
            trpc.installation.getRepoFilesystem.queryFilter({
              installationId,
              branch: pushToBranch,
            }),
          );
        }
      },
    }),
  );

  const pullsQuery = useQuery({
    ...trpc.installation.listPulls.queryOptions({ installationId, state: "open" }),
    enabled: !yoloMode,
  });
  const currentPr = useMemo(() => {
    if (yoloMode) return null;
    const pr = pullsQuery.data?.find((pr) => pr.head.ref === currentPrBranch);
    if (!pr) return null;
    return {
      number: pr.number,
      title: pr.title,
      headRef: pr.head.ref,
      baseRef: pr.base.ref,
    };
  }, [pullsQuery.data, currentPrBranch, yoloMode]);

  const createPullRequestMutation = useMutation(
    trpc.installation.createPullRequest.mutationOptions({
      onSuccess: () => {
        queryClient.invalidateQueries(
          trpc.installation.getRepoFilesystem.queryFilter({ installationId }),
        );
        queryClient.invalidateQueries(trpc.installation.listPulls.queryFilter({ installationId }));
      },
    }),
  );

  const mergePullMutation = useMutation(
    trpc.installation.mergePull.mutationOptions({
      onSuccess: () => {
        queryClient.invalidateQueries(trpc.installation.listPulls.queryFilter({ installationId }));
        queryClient.invalidateQueries(
          trpc.installation.getRepoFilesystem.queryFilter({ installationId }),
        );
        removeCurrentPrBranch();
      },
    }),
  );

  const closePullMutation = useMutation(
    trpc.installation.closePull.mutationOptions({
      onSuccess: () => {
        queryClient.invalidateQueries(trpc.installation.listPulls.queryFilter({ installationId }));
      },
    }),
  );

  const getDTSQuery = useQuery(
    trpc.installation.getDTS.queryOptions(
      {
        packageJson: JSON.parse(getRepoFileSystemQuery.data?.filesystem["package.json"] || "{}"),
        overrides: {
          "@iterate-com/sdk@workspace:*": `https://pkg.pr.new/iterate/iterate/@iterate-com/sdk@${sha || actualBranch || defaultBranch}`,
        },
      },
      {
        enabled: !!getRepoFileSystemQuery.data?.filesystem["package.json"],
        staleTime: Infinity,
      },
    ),
  );

  useEffect(() => {
    if (Object.keys(localEdits).length === 0 && Object.keys(filesFromRepo).length > 0) {
      setLocalEdits(filesFromRepo);
    }
  }, [filesFromRepo, localEdits, setLocalEdits]);

  // Derive valid selected file (reset if file no longer exists)
  const validSelectedFile = useMemo(() => {
    if (selectedFile && selectedFile in localEdits) {
      return selectedFile;
    }
    if ("iterate.config.ts" in localEdits) {
      return "iterate.config.ts";
    }
    return null;
  }, [selectedFile, localEdits]);

  // Build file tree from mergedFiles and wrap in root folder
  const fileTree = useMemo(() => {
    const tree = buildFileTree(Object.entries(localEdits));
    // Wrap in root folder based on repo name
    return [
      {
        name: repoName,
        path: "",
        type: "folder" as const,
        children: tree,
      },
    ];
  }, [localEdits, repoName]);
  const currentContent = validSelectedFile ? localEdits[validSelectedFile] : "";

  const handleToggleFolder = (path: string) => {
    setCollapsedFolders((prev) => ({ ...prev, [path]: !prev[path] }));
  };

  const [newFileDialogOpen, setNewFileDialogOpen] = useState(false);
  const [newFileState, setNewFileState] = useState<{ folderPath: string; contents: string } | null>(
    null,
  );
  const [newFileName, setNewFileName] = useState("");

  const handleNewFile = ({ folderPath = "", fileName = "", contents = "" } = {}) => {
    if (fileName) {
      const fullPath = folderPath ? `${folderPath}/${fileName}` : fileName;
      setLocalEdits((prev) => ({
        ...prev,
        [fullPath]: contents,
      }));
      setSelectedFile(fullPath);
      // Expand the folder if it's collapsed
      if (folderPath && collapsedFolders.has(folderPath)) {
        handleToggleFolder(folderPath);
      }
    } else {
      setNewFileState({ folderPath, contents });
      setNewFileName("");
      setNewFileDialogOpen(true);
    }
  };

  const confirmNewFile = () => {
    if (!newFileState || !newFileName.trim()) {
      setNewFileDialogOpen(false);
      setNewFileState(null);
      return;
    }

    const fullPath = newFileState.folderPath
      ? `${newFileState.folderPath}/${newFileName.trim()}`
      : newFileName.trim();
    setLocalEdits((prev) => ({
      ...prev,
      [fullPath]: newFileState.contents,
    }));
    setSelectedFile(fullPath);
    // Expand the folder if it's collapsed
    if (newFileState.folderPath && collapsedFolders.has(newFileState.folderPath)) {
      handleToggleFolder(newFileState.folderPath);
    }
    setNewFileDialogOpen(false);
    setNewFileState(null);
    setNewFileName("");
  };

  const [newFolderDialogOpen, setNewFolderDialogOpen] = useState(false);
  const [newFolderParentPath, setNewFolderParentPath] = useState<string | null>(null);
  const [newFolderName, setNewFolderName] = useState("");

  const handleNewFolder = (parentPath: string) => {
    setNewFolderParentPath(parentPath);
    setNewFolderName("");
    setNewFolderDialogOpen(true);
  };

  const confirmNewFolder = () => {
    if (!newFolderParentPath || !newFolderName.trim()) {
      setNewFolderDialogOpen(false);
      setNewFolderParentPath(null);
      return;
    }

    const fullPath = newFolderParentPath
      ? `${newFolderParentPath}/${newFolderName.trim()}`
      : newFolderName.trim();
    // Create a placeholder file in the folder to make it appear
    const placeholderPath = `${fullPath}/.gitkeep`;
    setLocalEdits((prev) => ({
      ...prev,
      [placeholderPath]: "",
    }));
    // Expand parent folder
    if (newFolderParentPath && collapsedFolders.has(newFolderParentPath)) {
      handleToggleFolder(newFolderParentPath);
    }
    setNewFolderDialogOpen(false);
    setNewFolderParentPath(null);
    setNewFolderName("");
  };

  const [renameDialogOpen, setRenameDialogOpen] = useState(false);
  const [fileToRename, setFileToRename] = useState<{
    path: string;
    name: string;
    type: "file" | "folder";
  } | null>(null);
  const [renameValue, setRenameValue] = useState("");

  const handleRename = (oldPath: string, newPath: string) => {
    if (oldPath === newPath) return;
    setLocalEdits((prev) => ({
      ...prev,
      [newPath]: prev?.[oldPath] ?? null,
      [oldPath]: null,
    }));
    if (validSelectedFile === oldPath) setSelectedFile(newPath);
  };

  const openRenameDialog = (path: string, name: string, type: "file" | "folder") => {
    setFileToRename({ path, name, type });
    setRenameValue(name);
    setRenameDialogOpen(true);
  };

  const confirmRename = () => {
    if (!fileToRename || !renameValue.trim() || renameValue === fileToRename.name) {
      setRenameDialogOpen(false);
      setFileToRename(null);
      return;
    }

    const parentPath = fileToRename.path.split("/").slice(0, -1).join("/");
    const newPath = parentPath ? `${parentPath}/${renameValue.trim()}` : renameValue.trim();
    handleRename(fileToRename.path, newPath);
    setRenameDialogOpen(false);
    setFileToRename(null);
    setRenameValue("");
  };

  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [fileToDelete, setFileToDelete] = useState<string | null>(null);

  const handleDelete = (path: string) => {
    setFileToDelete(path);
    setDeleteDialogOpen(true);
  };

  const confirmDelete = () => {
    if (!fileToDelete) return;

    setLocalEdits((prev) => {
      const updated = { ...prev };
      updated[fileToDelete] = null;
      for (const otherpath of Object.keys(filesFromRepo)) {
        if (otherpath.startsWith(fileToDelete + "/")) {
          updated[otherpath] = null;
        }
      }
      return updated;
    });
    // Clear selection if deleted file was selected
    if (validSelectedFile === fileToDelete || validSelectedFile?.startsWith(fileToDelete + "/")) {
      setSelectedFile(null);
    }
    setDeleteDialogOpen(false);
    setFileToDelete(null);
  };

  // Check if a file has been edited
  const isFileEdited = (filename: string): boolean => {
    const local = localEdits[filename] ?? undefined;
    const remote = (filesFromRepo as Record<string, string>)[filename] ?? undefined;
    return local !== remote;
  };

  const handleContentChange = (newContent: string) => {
    if (validSelectedFile) {
      setLocalEdits((prev) => ({
        ...prev,
        [validSelectedFile]: newContent,
      }));
    }
  };

  const handleDiscardEdits = () => {
    // Clear all local edits for the current branch
    setLocalEdits({});
    // Invalidate and refetch the repo filesystem query
    queryClient.invalidateQueries(
      trpc.installation.getRepoFilesystem.queryFilter({
        installationId,
        branch: yoloMode ? undefined : currentPrBranch,
      }),
    );
    // Also invalidate for pushToBranch if different
    if (pushToBranch && pushToBranch !== currentPrBranch) {
      queryClient.invalidateQueries(
        trpc.installation.getRepoFilesystem.queryFilter({
          installationId,
          branch: pushToBranch,
        }),
      );
    }
  };

  const handleSaveAll = (filepaths = Object.keys(localEdits)) => {
    const additions: { path: string; contents: string }[] = [];
    const deletions: { path: string }[] = [];
    filepaths.forEach((filename) => {
      if (isFileEdited(filename)) {
        const content = localEdits[filename];
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

    if (!summary) {
      toast.error("No changes to save");
      return;
    }

    updateRepoMutation.mutate({
      installationId,
      commit: {
        branch: {
          branchName: pushToBranch || defaultBranch || "main",
          repositoryNameWithOwner: repoData?.full_name || "",
        },
        expectedHeadOid: sha,
        message: { headline: summary },
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

  const getMonaco = () => editorRef.current?.[1];

  useEffect(() => {
    const monaco = getMonaco();
    if (!monaco) return;
    getDTSQuery.data?.forEach((p) => {
      Object.entries(p.files).forEach(([filename, content]) => {
        monaco.languages.typescript.typescriptDefaults.addExtraLib(
          content,
          `file:///node_modules/${p.packageJson.name}/${filename}`,
        );
      });
    });
  }, [getDTSQuery.data, validSelectedFile, viewMode]);

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

  const language = getLanguage(validSelectedFile || "");

  const monacoTheme = useMemo(
    () => (resolvedTheme === "dark" ? "vs-dark" : "light"),
    [resolvedTheme],
  );

  const monacoLanguage = useMemo(() => language || "markdown", [language]);

  const commonEditorOptions = useMemo(
    () => ({
      wordWrap: "on" as const,
      fixedOverflowWidgets: true,
    }),
    [],
  );

  const monacoBeforeMount = useCallback(
    (monaco: Parameters<NonNullable<Parameters<typeof Editor>[0]["beforeMount"]>>[0]) => {
      monaco.languages.json.jsonDefaults.setDiagnosticsOptions({
        enableSchemaRequest: true,
      });

      const tsconfig = JSON.parse(
        getRepoFileSystemQuery.data?.filesystem["tsconfig.json"] || "{}",
      ) as import("type-fest").TsConfigJson;
      const { jsx, module, moduleResolution, newLine, target, plugins, ...compilerOptions } =
        tsconfig.compilerOptions || {};
      monaco.languages.typescript.typescriptDefaults.setCompilerOptions({
        ...monaco.languages.typescript.typescriptDefaults.getCompilerOptions(),
        ...compilerOptions,
        strict: false,
        lib: ["es6", "DOM"],
        allowJs: true,
        allowImportingTsExtensions: true,
        allowSyntheticDefaultImports: true,
        typeRoots: ["file:///node_modules"],
      });
    },
    [getRepoFileSystemQuery.data],
  );

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

  const handleBranchSelect = useCallback(
    (branch: string) => {
      if (!yoloMode) {
        setCurrentPrBranch(branch);
      }
    },
    [setCurrentPrBranch, yoloMode],
  );

  const [newBranchDialogOpen, setNewBranchDialogOpen] = useState(false);
  const [newBranchName, setNewBranchName] = useState("");
  const [pendingActionAfterBranch, setPendingActionAfterBranch] = useState<
    "push" | "createPr" | null
  >(null);

  const handleCreateNewBranch = useCallback((action?: "push" | "createPr") => {
    const defaultBranchName = `ide/${formatDate(new Date(), "yyyy-MM-dd-HH-mm-ss")}`;
    setNewBranchName(defaultBranchName);
    setPendingActionAfterBranch(action || null);
    setNewBranchDialogOpen(true);
  }, []);

  const confirmNewBranch = () => {
    if (newBranchName.trim()) {
      const newBranch = newBranchName.trim();
      setCurrentPrBranch(newBranch);

      // Execute pending action after branch is created
      if (pendingActionAfterBranch === "push") {
        // Wait for state to update, then push
        setTimeout(() => {
          handleSaveAll();
        }, 100);
      } else if (pendingActionAfterBranch === "createPr") {
        // Wait for state to update, then create PR
        setTimeout(() => {
          createPullRequestMutation.mutate({ installationId, fromBranch: newBranch });
        }, 100);
      }
    }
    setNewBranchDialogOpen(false);
    setNewBranchName("");
    setPendingActionAfterBranch(null);
  };

  const [mergeDialogOpen, setMergeDialogOpen] = useState(false);
  const [prToMerge, setPrToMerge] = useState<number | null>(null);

  const handleMergePr = (pullNumber: number) => {
    setPrToMerge(pullNumber);
    setMergeDialogOpen(true);
  };

  const confirmMerge = () => {
    if (prToMerge && currentPr) {
      mergePullMutation.mutate(
        { installationId, pullNumber: prToMerge, mergeMethod: "squash" },
        {
          onSuccess: async () => {
            localStorage.removeItem(`iterate-ide-local-edits-${installationId}`);

            // Invalidate and refetch queries
            await queryClient.refetchQueries(
              trpc.installation.listPulls.queryFilter({ installationId, state: "open" }),
            );
            queryClient.invalidateQueries(
              trpc.installation.getRepoFilesystem.queryFilter({ installationId }),
            );

            setSelectedFile(null);
          },
        },
      );
      setMergeDialogOpen(false);
      setPrToMerge(null);
    }
  };

  const [closeDialogOpen, setCloseDialogOpen] = useState(false);
  const [prToClose, setPrToClose] = useState<number | null>(null);

  const handleClosePr = (pullNumber: number) => {
    setPrToClose(pullNumber);
    setCloseDialogOpen(true);
  };

  const confirmClose = () => {
    if (prToClose && currentPr) {
      closePullMutation.mutate(
        { installationId, pullNumber: prToClose },
        {
          onSuccess: async () => {
            // Clear local edits
            localStorage.removeItem(`iterate-ide-local-edits-${installationId}`);
            // Invalidate and refetch queries
            await queryClient.refetchQueries(
              trpc.installation.listPulls.queryFilter({ installationId, state: "open" }),
            );

            // Get updated pulls data
            const pullsData = queryClient.getQueryData(
              trpc.installation.listPulls.queryKey({ installationId, state: "open" }),
            ) as typeof pullsQuery.data | undefined;

            // Find latest PR (highest number) or fall back to default branch
            const latestPr =
              pullsData && pullsData.length > 0
                ? pullsData.reduce((latest, pr) => (pr.number > latest.number ? pr : latest))
                : null;

            const nextBranch = latestPr?.head.ref || defaultBranch || "main";
            setCurrentPrBranch(nextBranch);
            setSelectedFile(null);
          },
        },
      );
      setCloseDialogOpen(false);
      setPrToClose(null);
    }
  };

  return (
    <div ref={containerRef} className="flex h-[calc(100vh-8rem)] overflow-hidden">
      {/* Consolidated sidebar */}
      <div className="w-64 shrink-0 border-r bg-muted/30 overflow-y-auto flex flex-col">
        {/* Yolo mode toggle */}
        <div className="p-2 border-b">
          <div className="flex items-center justify-between gap-2">
            <Label htmlFor="yolo-mode" className="text-xs font-semibold cursor-pointer">
              Yolo Mode
            </Label>
            <Switch
              id="yolo-mode"
              checked={yoloMode}
              onCheckedChange={(mode) => setMode(mode ? "yolo" : "pr")}
            />
          </div>
          {pushToBranch && (
            <div className="text-[10px] text-muted-foreground mt-1">Pushing to {pushToBranch}</div>
          )}
        </div>

        {/* Push button */}
        <div className="p-2 border-b">
          <Button
            onClick={() => {
              if (yoloMode) {
                handleSaveAll();
              } else if (currentPrBranch === defaultBranch) {
                handleCreateNewBranch("push");
              } else {
                handleSaveAll();
              }
            }}
            disabled={updateRepoMutation.isPending || getRepoFileSystemQuery.isPending}
            size="sm"
            variant="ghost"
            className="w-full h-7 text-xs gap-1.5"
          >
            <Upload className="h-3 w-3" />
            {updateRepoMutation.isPending
              ? "Pushing..."
              : getRepoFileSystemQuery.isPending
                ? "Loading..."
                : yoloMode && pushToBranch
                  ? `Push to ${pushToBranch}`
                  : "Push"}
          </Button>
        </div>

        {/* Discard edits button */}
        {Object.keys(localEdits || {}).length > 0 && (
          <div className="p-2 border-b">
            <Button
              onClick={handleDiscardEdits}
              disabled={getRepoFileSystemQuery.isPending}
              size="sm"
              variant="ghost"
              className="w-full h-7 text-xs gap-1.5 text-muted-foreground hover:text-destructive"
            >
              <Trash2 className="h-3 w-3" />
              Discard edits
            </Button>
          </div>
        )}

        {/* View mode toggle */}
        {validSelectedFile && (
          <div className="p-2 border-b">
            <Button
              variant="outline"
              size="sm"
              disabled={viewMode === "readonly"}
              onClick={() => setViewMode(viewMode === "diff" ? "edit" : "diff")}
              className="w-full h-7 text-xs gap-1.5"
            >
              {viewMode === "diff" ? (
                <>
                  <FileEdit className="h-3 w-3" />
                  Edit Mode
                </>
              ) : (
                <>
                  <GitCompare className="h-3 w-3" />
                  Diff Mode
                </>
              )}
            </Button>
          </div>
        )}

        {/* PR/Branch section - only show if pushToBranch is not the default branch */}
        {pushToBranch && defaultBranch && pushToBranch !== defaultBranch && (
          <>
            <div className="p-2 border-b">
              <div className="text-xs font-semibold mb-1">Pull Requests</div>
              <Button
                onClick={() => handleCreateNewBranch()}
                size="sm"
                variant="ghost"
                className="w-full h-7 text-xs gap-1.5"
              >
                <Plus className="h-3 w-3" />
                New Branch
              </Button>
            </div>
            <div className="flex-1 overflow-y-auto p-2">
              {pullsQuery.isLoading ? (
                <div className="text-xs text-muted-foreground p-2">Loading...</div>
              ) : pullsQuery.data && pullsQuery.data.length > 0 ? (
                <div className="space-y-1">
                  {pullsQuery.data.map((pr) => {
                    const isSelected = pr.head.ref === currentPrBranch;
                    return (
                      <button
                        key={pr.id}
                        onClick={() => handleBranchSelect(pr.head.ref)}
                        className={cn(
                          "w-full text-left px-2 py-1.5 text-xs rounded-sm hover:bg-accent transition-colors",
                          isSelected && "bg-accent font-medium",
                        )}
                        title={pr.title}
                      >
                        <div className="flex items-center gap-1.5">
                          <GitPullRequest className="h-3 w-3 shrink-0" />
                          <span className="truncate flex-1">#{pr.number}</span>
                        </div>
                        <div className="text-[10px] text-muted-foreground truncate mt-0.5">
                          {pr.head.ref}
                        </div>
                      </button>
                    );
                  })}
                </div>
              ) : (
                <div className="text-xs text-muted-foreground p-2">No `ide/*` PRs found</div>
              )}
              <div className="mt-2 pt-2 border-t">
                <div className="text-xs font-semibold mb-1">Current Branch</div>
                <div className="text-xs text-muted-foreground px-2 py-1 break-all">
                  {currentPrBranch}
                </div>
                {!branchExists && actualBranch && actualBranch !== currentPrBranch && (
                  <div className="text-[10px] text-orange-600 dark:text-orange-400 px-2 mt-1">
                    Branch doesn't exist yet, showing {actualBranch}
                  </div>
                )}
                {currentPr ? (
                  <div className="mt-2">
                    <div className="px-2 mb-2">
                      <div className="text-xs font-semibold mb-1">PR #{currentPr.number}</div>
                      <div className="text-[10px] text-muted-foreground line-clamp-2 mb-2">
                        {currentPr.title}
                      </div>
                      <div className="text-[10px] text-muted-foreground">
                        {currentPr.headRef} → {currentPr.baseRef}
                      </div>
                    </div>
                    <div className="flex gap-1">
                      {handleMergePr && (
                        <Button
                          onClick={() => handleMergePr(currentPr.number)}
                          size="sm"
                          variant="default"
                          className="flex-1 h-7 text-xs gap-1.5"
                        >
                          <GitMerge className="h-3 w-3" />
                          Merge
                        </Button>
                      )}
                      {handleClosePr && (
                        <Button
                          onClick={() => handleClosePr(currentPr.number)}
                          size="sm"
                          variant="destructive"
                          className="flex-1 h-7 text-xs gap-1.5"
                        >
                          <X className="h-3 w-3" />
                          Close
                        </Button>
                      )}
                    </div>
                  </div>
                ) : branchExists ? (
                  <div className="text-[10px] text-muted-foreground px-2 mt-1">
                    (No PR for this branch)
                  </div>
                ) : null}
              </div>

              {!currentPr && (
                <div className="border-t mt-2">
                  <Button
                    onClick={() => {
                      if (currentPrBranch === defaultBranch) {
                        handleCreateNewBranch("createPr");
                      } else {
                        createPullRequestMutation.mutate({
                          installationId,
                          fromBranch: currentPrBranch,
                        });
                      }
                    }}
                    disabled={createPullRequestMutation.isPending}
                    size="sm"
                    variant="ghost"
                    className="w-full h-7 text-xs mt-2 bg-accent"
                  >
                    <GitPullRequest className="h-3 w-3" />
                    Create PR
                  </Button>
                </div>
              )}
            </div>
          </>
        )}

        {/* File tree */}
        <div className="border-t p-2 flex-1 overflow-y-auto">
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
            onRenameOpen={openRenameDialog}
            onDelete={handleDelete}
          />
        </div>
        {getRepoFileSystemQuery.data?.filesystem &&
          !("iterate.config.ts" in getRepoFileSystemQuery.data.filesystem) && (
            <div className="p-2 border-t">
              <Button
                onClick={() =>
                  handleNewFile({
                    fileName: "iterate.config.ts",
                    contents: templateInstallationConfigString,
                  })
                }
                disabled={localEdits?.["iterate.config.ts"] !== undefined}
                variant="ghost"
                size="sm"
                className="w-full h-7 text-xs gap-1.5"
              >
                <IterateLetterI className="h-3 w-3" />
                Create iterate.config.ts
              </Button>
            </div>
          )}
      </div>

      {/* Main panel - Editor */}
      <div className="flex-1 min-w-0 relative flex flex-col">
        <div className="absolute top-2 right-2 z-10 flex items-center gap-2 bg-background/95 border rounded-md px-2 py-1 shadow-sm">
          {getRepoFileSystemQuery.isFetching && (
            <>
              <Spinner className="h-3 w-3" />
              <span className="text-xs text-muted-foreground">Refreshing...</span>
            </>
          )}
          {!getDTSQuery.isSuccess && !getDTSQuery.isError && (
            <>
              <Spinner className="h-3 w-3" />
              <span className="text-xs text-muted-foreground">Types {getDTSQuery.status}...</span>
            </>
          )}
          {getDTSQuery.isError && (
            <>
              <AlertTriangle className="h-3 w-3" />
              <span className="text-xs text-muted-foreground">
                Failed to get types: {getDTSQuery.error.message}
              </span>
            </>
          )}
        </div>
        {validSelectedFile ? (
          viewMode === "diff" ? (
            <DiffEditor
              key={validSelectedFile}
              height="100%"
              language={monacoLanguage}
              original={
                Object.keys(filesFromRepo).length === 0
                  ? currentContent || ""
                  : (filesFromRepo as Record<string, string>)[validSelectedFile] || ""
              }
              modified={currentContent || ""}
              theme={monacoTheme}
              options={{
                ...commonEditorOptions,
                readOnly: false,
                renderSideBySide: true,
              }}
              beforeMount={monacoBeforeMount}
              onMount={(editor) => {
                // Make original read-only, modified editable
                editor.getOriginalEditor().updateOptions({ readOnly: true });
                // Handle changes in the modified editor
                const modifiedEditor = editor.getModifiedEditor();
                modifiedEditor.onDidChangeModelContent(() => {
                  const value = modifiedEditor.getValue();
                  handleContentChange(value);
                });
              }}
            />
          ) : (
            <Editor
              path={validSelectedFile ? `file:///app/${validSelectedFile}` : undefined}
              height="100%"
              defaultLanguage={monacoLanguage}
              language={monacoLanguage}
              onChange={(val) => handleContentChange(val || "")}
              value={currentContent || ""}
              theme={monacoTheme}
              options={commonEditorOptions}
              beforeMount={monacoBeforeMount}
              onMount={onMount}
            />
          )
        ) : (
          <div className="flex items-center justify-center h-full text-muted-foreground">
            {selectedFile || "Select a file to edit"}
          </div>
        )}
      </div>

      {/* Delete Confirmation Dialog */}
      <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {fileToDelete}</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete this {fileToDelete?.includes(".") ? "file" : "folder"}
              ? This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setFileToDelete(null)}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={confirmDelete}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Rename Dialog */}
      <Dialog open={renameDialogOpen} onOpenChange={setRenameDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Rename {fileToRename?.type === "file" ? "File" : "Folder"}</DialogTitle>
            <DialogDescription>Enter a new name for {fileToRename?.name}</DialogDescription>
          </DialogHeader>
          <div className="py-4">
            <Input
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  confirmRename();
                }
              }}
              autoFocus
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRenameDialogOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={confirmRename}
              disabled={!renameValue.trim() || renameValue === fileToRename?.name}
            >
              Rename
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* New File Dialog */}
      <Dialog open={newFileDialogOpen} onOpenChange={setNewFileDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New File</DialogTitle>
            <DialogDescription>Enter a name for the new file</DialogDescription>
          </DialogHeader>
          <div className="py-4">
            <Input
              value={newFileName}
              onChange={(e) => setNewFileName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  confirmNewFile();
                }
              }}
              placeholder="filename.ts"
              autoFocus
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setNewFileDialogOpen(false)}>
              Cancel
            </Button>
            <Button onClick={confirmNewFile} disabled={!newFileName.trim()}>
              Create
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* New Folder Dialog */}
      <Dialog open={newFolderDialogOpen} onOpenChange={setNewFolderDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New Folder</DialogTitle>
            <DialogDescription>Enter a name for the new folder</DialogDescription>
          </DialogHeader>
          <div className="py-4">
            <Input
              value={newFolderName}
              onChange={(e) => setNewFolderName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  confirmNewFolder();
                }
              }}
              placeholder="folder-name"
              autoFocus
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setNewFolderDialogOpen(false)}>
              Cancel
            </Button>
            <Button onClick={confirmNewFolder} disabled={!newFolderName.trim()}>
              Create
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* New Branch Dialog */}
      <Dialog open={newBranchDialogOpen} onOpenChange={setNewBranchDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New Branch</DialogTitle>
            <DialogDescription>
              {pendingActionAfterBranch
                ? `Cannot work on ${defaultBranch} branch. Please create a new branch to continue.`
                : "Enter a name for the new branch"}
            </DialogDescription>
          </DialogHeader>
          <div className="py-4">
            <Input
              value={newBranchName}
              onChange={(e) => setNewBranchName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  confirmNewBranch();
                }
              }}
              placeholder="branch-name"
              autoFocus
            />
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setNewBranchDialogOpen(false);
                setPendingActionAfterBranch(null);
              }}
            >
              Cancel
            </Button>
            <Button onClick={confirmNewBranch} disabled={!newBranchName.trim()}>
              Create
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Merge PR Confirmation Dialog */}
      <AlertDialog open={mergeDialogOpen} onOpenChange={setMergeDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Merge Pull Request #{prToMerge}</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to merge this pull request? This will merge the branch into the
              base branch.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setPrToMerge(null)}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={confirmMerge}
              disabled={mergePullMutation.isPending}
              className="bg-primary text-primary-foreground hover:bg-primary/90"
            >
              {mergePullMutation.isPending ? "Merging..." : "Merge"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Close PR Confirmation Dialog */}
      <AlertDialog open={closeDialogOpen} onOpenChange={setCloseDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Close Pull Request #{prToClose}</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to close this pull request? This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setPrToClose(null)}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={confirmClose}
              disabled={closePullMutation.isPending}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {closePullMutation.isPending ? "Closing..." : "Close"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

// eslint + autofix will make sure the below variable stays in sync with the template installation config
// codegen:start {preset: str, source: ../../../../estates/template/iterate.config.ts, const: templateInstallationConfigString}
const templateInstallationConfigString =
  'import { contextRulesFromFiles, defineConfig, matchers } from "@iterate-com/sdk";\n\nconst config = defineConfig({\n  contextRules: [\n    // You can use "matchers" to conditionally apply rules.\n    // For example to only be active when certain MCP connections are present.\n    {\n      key: "how-we-use-linear",\n      prompt: "Tag any new issues with the label `iterate-tutorial`",\n      match: matchers.hasMCPConnection("linear"),\n    },\n\n    // Or when a certain user is on a thread\n    {\n      key: "jonas-rules",\n      prompt: "When Jonas is on a thread, remind him to lock in",\n      match: matchers.hasParticipant("jonas"),\n    },\n\n    // You can also use mathcers.and, matchers.or and matchers.not\n    {\n      key: "jonas-in-the-evening",\n      prompt: "It\'s between 22:00 - 06:00, remind jonas to go to sleep",\n      match: matchers.and(\n        matchers.hasParticipant("jonas"),\n        matchers.timeWindow({\n          timeOfDay: { start: "22:00", end: "06:00" },\n        }),\n      ),\n    },\n    // This file is "just typescript", so you can do whatever you want\n    // e.g. structure your rules in markdown, too, and use a helper to load them\n    ...contextRulesFromFiles("rules/**/*.md"),\n  ],\n});\nexport default config;\n';
// codegen:end
