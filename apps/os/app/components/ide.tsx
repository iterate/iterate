import Editor from "@monaco-editor/react";
import type { OnMount } from "@monaco-editor/react";
import { useSessionStorage, useLocalStorage } from "usehooks-ts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
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
  GitPullRequest,
  GitMerge,
  X,
  Plus,
} from "lucide-react";
import { useSearchParams } from "react-router";
import { formatDate } from "date-fns";
import { cn } from "../lib/utils.ts";
import { useTRPC } from "../lib/trpc.ts";
import { useEstateId } from "../hooks/use-estate.ts";
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

interface PRSidebarProps {
  estateId: string;
  currentBranch: string;
  onBranchSelect: (branch: string) => void;
  onCreateNewBranch: () => void;
  branchExists?: boolean;
  actualBranch?: string;
  currentPr: { number: number; title: string; headRef: string; baseRef: string } | null;
  onMergePr?: (pullNumber: number) => void;
  onClosePr?: (pullNumber: number) => void;
}

function PRSidebar({
  estateId,
  currentBranch,
  onBranchSelect,
  onCreateNewBranch,
  branchExists = true,
  actualBranch,
  currentPr,
  onMergePr,
  onClosePr,
}: PRSidebarProps) {
  const trpc = useTRPC();
  const pullsQuery = useQuery(trpc.estate.listPulls.queryOptions({ estateId, state: "open" }));

  return (
    <div className="w-48 shrink-0 border-r bg-muted/30 overflow-y-auto flex flex-col">
      <div className="p-2 border-b">
        <div className="text-xs font-semibold mb-1">Pull Requests</div>
        <Button
          onClick={onCreateNewBranch}
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
              const isSelected = pr.head.ref === currentBranch;
              return (
                <button
                  key={pr.id}
                  onClick={() => onBranchSelect(pr.head.ref)}
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
          <div className="text-xs text-muted-foreground p-2">No open PRs</div>
        )}
        <div className="mt-2 pt-2 border-t">
          <div className="text-xs font-semibold mb-1">Current Branch</div>
          <div className="text-xs text-muted-foreground px-2 py-1 break-all">{currentBranch}</div>
          {!branchExists && actualBranch && actualBranch !== currentBranch && (
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
                {onMergePr && (
                  <Button
                    onClick={() => onMergePr(currentPr.number)}
                    size="sm"
                    variant="default"
                    className="flex-1 h-7 text-xs gap-1.5"
                  >
                    <GitMerge className="h-3 w-3" />
                    Merge
                  </Button>
                )}
                {onClosePr && (
                  <Button
                    onClick={() => onClosePr(currentPr.number)}
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
      </div>
    </div>
  );
}

export function IDE() {
  const trpc = useTRPC();
  const estateId = useEstateId();

  const [searchParams, setSearchParams] = useSearchParams();
  const selectedFile = searchParams.get("file");
  const setSelectedFile = useCallback(
    (file: string | null) => {
      const newParams = Object.fromEntries(searchParams);
      if (typeof file === "string") newParams.file = file;
      setSearchParams(new URLSearchParams(newParams));
    },
    [searchParams, setSearchParams],
  );
  const [currentPrBranch, setCurrentPrBranch] = useLocalStorage<string>(
    "iterate-pr-branch",
    () => `ide/${formatDate(new Date(), "yyyy-MM-dd-HH-mm")}`,
  );

  // Use localStorage for per-branch local edits
  const [localEdits, setLocalEdits] = useLocalStorage<Record<string, string | null>>(
    `iterate-local-edits-${currentPrBranch}`,
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

  const queryClient = useQueryClient();

  const getRepoFilesystemQueryOptions = useMemo(
    () =>
      trpc.estate.getRepoFilesystem.queryOptions({
        estateId,
        branch: currentPrBranch,
      }),
    [trpc, estateId, currentPrBranch],
  );

  const saveFileMutation = useMutation(
    trpc.estate.updateRepo.mutationOptions({
      onSuccess: (_data, variables) => {
        const edited = new Set([
          ...(variables.commit.fileChanges.additions?.map((addition) => addition.path) || []),
          ...(variables.commit.fileChanges.deletions?.map((deletion) => deletion.path) || []),
        ]);

        queryClient.invalidateQueries(
          trpc.estate.getRepoFilesystem.queryFilter({ estateId, branch: currentPrBranch }),
        );
        setExpectedEdits(localEdits || {});
        setLocalEdits(
          localEdits &&
            Object.fromEntries(Object.entries(localEdits).filter(([k]) => !edited.has(k))),
        );
      },
    }),
  );

  const pullsQuery = useQuery(trpc.estate.listPulls.queryOptions({ estateId, state: "open" }));
  const currentPr = useMemo(() => {
    const pr = pullsQuery.data?.find((pr) => pr.head.ref === currentPrBranch);
    if (!pr) return null;
    return {
      number: pr.number,
      title: pr.title,
      headRef: pr.head.ref,
      baseRef: pr.base.ref,
    };
  }, [pullsQuery.data, currentPrBranch]);

  const createPullRequestMutation = useMutation(
    trpc.estate.createPullRequest.mutationOptions({
      onSuccess: () => {
        queryClient.invalidateQueries(trpc.estate.getRepoFilesystem.queryFilter({ estateId }));
        queryClient.invalidateQueries(trpc.estate.listPulls.queryFilter({ estateId }));
      },
    }),
  );

  const mergePullMutation = useMutation(
    trpc.estate.mergePull.mutationOptions({
      onSuccess: () => {
        queryClient.invalidateQueries(trpc.estate.listPulls.queryFilter({ estateId }));
        queryClient.invalidateQueries(trpc.estate.getRepoFilesystem.queryFilter({ estateId }));
      },
    }),
  );

  const closePullMutation = useMutation(
    trpc.estate.closePull.mutationOptions({
      onSuccess: () => {
        queryClient.invalidateQueries(trpc.estate.listPulls.queryFilter({ estateId }));
      },
    }),
  );

  const getRepoFileSystemQuery = useQuery({
    ...getRepoFilesystemQueryOptions,
    enabled: !!currentPrBranch,
    // Only use placeholder data if it's for the same branch
    placeholderData: (old) => {
      if (!old) return undefined;
      // Only use placeholder if it's for the same branch
      if (old.requestedBranch === currentPrBranch) {
        return { ...old, filesystem: { ...old.filesystem, ...expectedEdits }, sha: "" };
      }
      return undefined;
    },
  });

  const dts = useQuery(
    trpc.estate.getDTS.queryOptions(
      {
        packageJson: JSON.parse(getRepoFileSystemQuery.data?.filesystem["package.json"] || "{}"),
      },
      {
        enabled: !!getRepoFileSystemQuery.data?.filesystem["package.json"],
        staleTime: Infinity,
      },
    ),
  );

  const {
    filesystem,
    sha,
    repoData,
    branchExists = true,
    branch: actualBranch,
    defaultBranch = "main",
  } = getRepoFileSystemQuery.data || {
    filesystem: {},
    sha: "",
    repoData: null,
    branchExists: true,
    requestedBranch: currentPrBranch,
    branch: currentPrBranch,
    defaultBranch: "main",
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
      for (const otherpath of Object.keys(filesystem)) {
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
    return fileContents[filename] !== (filesystem as Record<string, string>)[filename];
  };

  const handleContentChange = (newContent: string) => {
    if (validSelectedFile) {
      setLocalEdits((prev) => ({
        ...prev,
        [validSelectedFile]: newContent,
      }));
    }
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
        branch: {
          branchName: currentPrBranch,
          repositoryNameWithOwner: repoData?.full_name || "",
        },
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

  const getMonaco = () => editorRef.current?.[1];

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

  const handleBranchSelect = useCallback(
    (branch: string) => {
      setCurrentPrBranch(branch);
    },
    [setCurrentPrBranch],
  );

  const [newBranchDialogOpen, setNewBranchDialogOpen] = useState(false);
  const [newBranchName, setNewBranchName] = useState("");
  const [pendingActionAfterBranch, setPendingActionAfterBranch] = useState<
    "push" | "createPr" | null
  >(null);

  const handleCreateNewBranch = useCallback((action?: "push" | "createPr") => {
    const defaultBranchName = `ide/${formatDate(new Date(), "yyyy-MM-dd-HH-mm")}`;
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
          createPullRequestMutation.mutate({ estateId, fromBranch: newBranch });
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
      const branchToClear = currentPr.headRef;
      mergePullMutation.mutate(
        { estateId, pullNumber: prToMerge, mergeMethod: "merge" },
        {
          onSuccess: async () => {
            localStorage.removeItem(`iterate-local-edits-${branchToClear}`);

            // Invalidate and refetch queries
            await queryClient.refetchQueries(
              trpc.estate.listPulls.queryFilter({ estateId, state: "open" }),
            );
            queryClient.invalidateQueries(trpc.estate.getRepoFilesystem.queryFilter({ estateId }));

            // Get updated pulls data
            const pullsData = queryClient.getQueryData(
              trpc.estate.listPulls.queryKey({ estateId, state: "open" }),
            ) as typeof pullsQuery.data | undefined;

            // Find latest PR (highest number) or fall back to default branch
            const latestPr =
              pullsData && pullsData.length > 0
                ? pullsData.reduce((latest, pr) => (pr.number > latest.number ? pr : latest))
                : null;

            const nextBranch = latestPr?.head.ref || defaultBranch;
            setCurrentPrBranch(nextBranch);
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
      const branchToClear = currentPr.headRef;
      closePullMutation.mutate(
        { estateId, pullNumber: prToClose },
        {
          onSuccess: async () => {
            // Clear local edits for the closed branch
            localStorage.removeItem(`iterate-local-edits-${branchToClear}`);
            // Invalidate and refetch queries
            await queryClient.refetchQueries(
              trpc.estate.listPulls.queryFilter({ estateId, state: "open" }),
            );

            // Get updated pulls data
            const pullsData = queryClient.getQueryData(
              trpc.estate.listPulls.queryKey({ estateId, state: "open" }),
            ) as typeof pullsQuery.data | undefined;

            // Find latest PR (highest number) or fall back to default branch
            const latestPr =
              pullsData && pullsData.length > 0
                ? pullsData.reduce((latest, pr) => (pr.number > latest.number ? pr : latest))
                : null;

            const nextBranch = latestPr?.head.ref || defaultBranch;
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
    <div className="flex h-[calc(100vh-8rem)] overflow-hidden">
      {/* PR Sidebar */}
      <PRSidebar
        estateId={estateId}
        currentBranch={currentPrBranch}
        onBranchSelect={handleBranchSelect}
        onCreateNewBranch={handleCreateNewBranch}
        branchExists={branchExists}
        actualBranch={actualBranch}
        currentPr={currentPr}
        onMergePr={handleMergePr}
        onClosePr={handleClosePr}
      />
      {/* File tree sidebar */}
      <div className="w-48 shrink-0 border-r bg-muted/30 overflow-y-auto flex flex-col">
        <div className="p-2 border-b">
          <Button
            onClick={() => {
              if (currentPrBranch === defaultBranch) {
                handleCreateNewBranch("push");
              } else {
                handleSaveAll();
              }
            }}
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
            {saveFileMutation.isPending
              ? "Pushing..."
              : getRepoFileSystemQuery.isPending
                ? "Loading..."
                : `Push`}
          </Button>
          {!currentPr && (
            <Button
              onClick={() => {
                if (currentPrBranch === defaultBranch) {
                  handleCreateNewBranch("createPr");
                } else {
                  createPullRequestMutation.mutate({ estateId, fromBranch: currentPrBranch });
                }
              }}
              disabled={createPullRequestMutation.isPending}
              size="sm"
              variant="ghost"
              className="w-full h-7 text-xs gap-1.5"
            >
              <GitPullRequest className="h-3 w-3" />
              Create PR
            </Button>
          )}
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
            onRenameOpen={openRenameDialog}
            onDelete={handleDelete}
          />
        </div>
        {getRepoFileSystemQuery.data?.filesystem &&
          !("iterate.config.ts" in getRepoFileSystemQuery.data.filesystem) && (
            <div className="p-2 border-b">
              <Button
                onClick={() =>
                  handleNewFile({
                    fileName: "iterate.config.ts",
                    contents: templateEstateConfigString,
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
      <div className="flex-1 min-w-0 relative">
        {getRepoFileSystemQuery.isFetching ? (
          <div className="absolute top-2 right-2 z-10 flex items-center gap-2 bg-background/95 border rounded-md px-2 py-1 shadow-sm">
            <Spinner className="h-3 w-3" />
            <span className="text-xs text-muted-foreground">Refreshing...</span>
          </div>
        ) : null}
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
              monaco.languages.json.jsonDefaults.setDiagnosticsOptions({
                enableSchemaRequest: true, // use fetch to get json schema for intellisense for tsconfig etc.
              });

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

// eslint + autofix will make sure the below variable stays in sync with estates/template/iterate.config.ts
// codegen:start {preset: str, source: ../../../../estates/template/iterate.config.ts, const: templateEstateConfigString}
const templateEstateConfigString =
  'import { contextRulesFromFiles, defineConfig, matchers } from "@iterate-com/sdk";\n\nconst config = defineConfig({\n  contextRules: [\n    // You can use "matchers" to conditionally apply rules\n    // For example to only be active when certain MCP connections are present\n    {\n      key: "how-we-use-linear",\n      prompt: "Tag any new issues with the label `iterate-tutorial`",\n      match: matchers.hasMCPConnection("linear"),\n    },\n\n    // Or when a certain user is on a thread\n    {\n      key: "jonas-rules",\n      prompt: "When Jonas is on a thread, remind him to lock in",\n      match: matchers.hasParticipant("jonas"),\n    },\n\n    // You can also use mathcers.and, matchers.or and matchers.not\n    {\n      key: "jonas-in-the-evening",\n      prompt: "It\'s between 22:00 - 06:00, remind jonas to go to sleep",\n      match: matchers.and(\n        matchers.hasParticipant("jonas"),\n        matchers.timeWindow({\n          timeOfDay: { start: "22:00", end: "06:00" },\n        }),\n      ),\n    },\n    // This file is "just typescript", so you can do whatever you want\n    // e.g. structure your rules in markdown, too, and use a helper to load them\n    ...contextRulesFromFiles("rules/**/*.md"),\n  ],\n});\nexport default config;\n';
// codegen:end
