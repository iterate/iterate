import React, { useState } from "react";
import {
  Github,
  ArrowRight,
  Edit2,
  Loader2,
  ChevronDown,
  ChevronRight,
  CheckCircle,
  XCircle,
  RefreshCw,
  Hammer,
  Clock,
  Info,
} from "lucide-react";
import { toast } from "sonner";
import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import type { inferRouterOutputs } from "@trpc/server";
import { Button } from "../../../components/ui/button.tsx";
import { Input } from "../../../components/ui/input.tsx";
import { useTRPC } from "../../../lib/trpc.ts";
import { useEstateId } from "../../../hooks/use-estate.ts";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../../components/ui/select.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../../components/ui/dialog.tsx";
import type { AppRouter } from "../../../../backend/trpc/root.ts";
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "../../../components/ui/item.tsx";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "../../../components/ui/empty.tsx";

// Use tRPC's built-in type inference for the build type
type RouterOutputs = inferRouterOutputs<AppRouter>;
type Build = RouterOutputs["estate"]["getBuilds"][0];

export function meta() {
  return [
    { title: "Manage Estate - Iterate Dashboard" },
    {
      name: "description",
      content: "Manage your estate and connect to GitHub",
    },
  ];
}

function EstateContent() {
  const [isEditingRepo, setIsEditingRepo] = useState(false);
  const [selectedRepo, setSelectedRepo] = useState<string>("");
  const [repoPath, setRepoPath] = useState<string | undefined>(undefined);
  const [repoBranch, setRepoBranch] = useState<string | undefined>(undefined);
  const [expandedBuilds, setExpandedBuilds] = useState<Set<string>>(new Set());
  const [isRebuildDialogOpen, setIsRebuildDialogOpen] = useState(false);
  const [rebuildTarget, setRebuildTarget] = useState("");
  const [rebuildTargetType, setRebuildTargetType] = useState<"branch" | "commit">("branch");

  // Get estate ID from URL
  const estateId = useEstateId();
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  const { data: connectedRepo } = useSuspenseQuery(
    trpc.integrations.getGithubRepoForEstate.queryOptions({
      estateId: estateId,
    }),
  );
  const { data: repos } = useSuspenseQuery(
    trpc.integrations.listAvailableGithubRepos.queryOptions({
      estateId: estateId,
    }),
  );

  const { data: builds, isLoading: buildsLoading } = useSuspenseQuery(
    trpc.estate.getBuilds.queryOptions({
      estateId: estateId,
      limit: 10,
    }),
  );

  // Compute display values for repo fields
  // Use state values if they've been explicitly set (including empty string), otherwise use defaults
  const displaySelectedRepo = selectedRepo || connectedRepo?.repoId?.toString() || "";
  const displayRepoPath = repoPath !== undefined ? repoPath : connectedRepo?.path || "/";
  const displayRepoBranch = repoBranch !== undefined ? repoBranch : connectedRepo?.branch || "main";

  const setGithubRepoForEstateMutation = useMutation(
    trpc.integrations.setGithubRepoForEstate.mutationOptions({}),
  );
  const startGithubAppInstallFlowMutation = useMutation(
    trpc.integrations.startGithubAppInstallFlow.mutationOptions({}),
  );

  const triggerRebuildMutation = useMutation(trpc.estate.triggerRebuild.mutationOptions({}));

  const handleConnectRepo = () => {
    if (!displaySelectedRepo) {
      toast.error("Please select a repository");
      return;
    }

    setGithubRepoForEstateMutation.mutate(
      {
        estateId: estateId!,
        repoId: parseInt(displaySelectedRepo),
        path: displayRepoPath,
        branch: displayRepoBranch,
      },
      {
        onSuccess: () => {
          toast.success(
            isEditingRepo
              ? "Configuration updated successfully"
              : "GitHub repository connected successfully",
          );
          setIsEditingRepo(false);
          queryClient.invalidateQueries({
            queryKey: trpc.integrations.getGithubRepoForEstate.queryKey({ estateId }),
          });
        },
        onError: () => {
          toast.error(
            isEditingRepo
              ? "Failed to update configuration"
              : "Failed to set GitHub repository for estate",
          );
        },
      },
    );
  };

  const handleConnectGitHub = async () => {
    try {
      const { installationUrl } = await startGithubAppInstallFlowMutation.mutateAsync({
        estateId: estateId!,
      });
      window.location.href = installationUrl;
    } catch {
      toast.error("Failed to start GitHub connection flow");
    }
  };

  const toggleBuildExpanded = (buildId: string) => {
    setExpandedBuilds((prev) => {
      const newSet = new Set(prev);
      if (newSet.has(buildId)) {
        newSet.delete(buildId);
      } else {
        newSet.add(buildId);
      }
      return newSet;
    });
  };

  const getBuildStatusIcon = (status: string) => {
    switch (status) {
      case "complete":
        return <CheckCircle className="h-5 w-5 text-green-600" />;
      case "failed":
        return <XCircle className="h-5 w-5 text-red-600" />;
      case "in_progress":
        return <RefreshCw className="h-5 w-5 text-blue-600 animate-spin" />;
      default:
        return <Clock className="h-5 w-5 text-gray-600" />;
    }
  };

  const getBuildStatusColor = (status: string) => {
    switch (status) {
      case "complete":
        return "text-green-700 bg-green-50 dark:text-green-400 dark:bg-green-900/20";
      case "failed":
        return "text-red-700 bg-red-50 dark:text-red-400 dark:bg-red-900/20";
      case "in_progress":
        return "text-blue-700 bg-blue-50 dark:text-blue-400 dark:bg-blue-900/20";
      default:
        return "text-gray-700 bg-gray-50 dark:text-gray-400 dark:bg-gray-900/20";
    }
  };

  const formatDate = (date: Date | string) => {
    const d = new Date(date);
    return d.toLocaleString("en-US", {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  };

  const handleTriggerRebuild = () => {
    if (!rebuildTarget.trim()) {
      toast.error(`Please enter a ${rebuildTargetType} to rebuild`);
      return;
    }

    triggerRebuildMutation.mutate(
      {
        estateId: estateId!,
        target: rebuildTarget.trim(),
        targetType: rebuildTargetType,
      },
      {
        onSuccess: (data) => {
          toast.success(data.message || "Rebuild triggered successfully");
          setIsRebuildDialogOpen(false);
          setRebuildTarget(""); // Reset
          setRebuildTargetType("branch"); // Reset to default
          // Refresh the builds list
          queryClient.invalidateQueries({
            queryKey: trpc.estate.getBuilds.queryKey({ estateId }),
          });
        },
        onError: (error) => {
          toast.error(error.message || "Failed to trigger rebuild");
        },
      },
    );
  };

  const handleRebuildCommit = (build: Build) => {
    triggerRebuildMutation.mutate(
      {
        estateId: estateId!,
        target: build.commitHash,
        targetType: "commit" as const,
      },
      {
        onSuccess: () => {
          toast.success(`Rebuilding commit ${build.commitHash.substring(0, 7)}`);
          // Refresh the builds list
          queryClient.invalidateQueries({
            queryKey: trpc.estate.getBuilds.queryKey({ estateId }),
          });
        },
        onError: (error) => {
          toast.error(error.message || "Failed to trigger rebuild");
        },
      },
    );
  };

  return (
    <div className="p-6 space-y-6">
      {/* Top Row - Two Cards Side by Side */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Git Repository Explanation */}
        <Item variant="muted" className="items-start">
          <ItemMedia variant="icon">
            <Info className="h-5 w-5" />
          </ItemMedia>
          <ItemContent>
            <ItemTitle>About Git Repository</ItemTitle>
            <ItemDescription>
              Your Git repository serves as the central hub for all agent context, configurations,
              and data persistence. It stores your context rules, memories and ensures your AI
              estate remains consistent across deployments.
            </ItemDescription>
          </ItemContent>
        </Item>

        {/* Repository Configuration */}
        <Item variant="muted" className="items-start">
          <ItemMedia variant="icon">
            <Github className="h-5 w-5" />
          </ItemMedia>
          <ItemContent>
            {connectedRepo && !isEditingRepo ? (
              <>
                <div className="space-y-2">
                  <div className="flex items-baseline gap-2">
                    <span className="text-sm text-muted-foreground shrink-0">Repository:</span>
                    <span className="font-mono text-sm">
                      {connectedRepo.repoFullName || connectedRepo.repoName}
                    </span>
                  </div>
                  <div className="flex items-baseline gap-2">
                    <span className="text-sm text-muted-foreground shrink-0">Branch:</span>
                    <span className="font-mono text-sm">{connectedRepo.branch}</span>
                  </div>
                  <div className="flex items-baseline gap-2">
                    <span className="text-sm text-muted-foreground shrink-0">Path:</span>
                    <span className="font-mono text-sm">{connectedRepo.path}</span>
                  </div>
                </div>
                <div className="flex gap-2 mt-4">
                  <Button
                    variant="outline"
                    size="sm"
                    className="flex-1"
                    onClick={() => setIsEditingRepo(true)}
                  >
                    <Edit2 className="h-4 w-4 mr-2" />
                    Edit Configuration
                  </Button>
                  <Button
                    size="sm"
                    className="flex-1"
                    onClick={() => {
                      if (connectedRepo?.repoFullName) {
                        window.open(`https://github.com/${connectedRepo.repoFullName}`, "_blank");
                      } else {
                        window.open("https://github.com", "_blank");
                      }
                    }}
                  >
                    Go to GitHub
                    <ArrowRight className="h-4 w-4 ml-2" />
                  </Button>
                </div>
              </>
            ) : repos && repos.length > 0 ? (
              <>
                <div>
                  <label className="block text-sm font-medium mb-2">Repository</label>
                  <Select value={displaySelectedRepo} onValueChange={setSelectedRepo}>
                    <SelectTrigger>
                      <SelectValue placeholder="Select a repository" />
                    </SelectTrigger>
                    <SelectContent>
                      {repos?.map((repo) => (
                        <SelectItem key={repo.id} value={repo.id.toString()}>
                          {repo.full_name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium mb-2">Branch (default: main)</label>
                    <Input
                      value={displayRepoBranch}
                      onChange={(e) => setRepoBranch(e.target.value)}
                      placeholder="main"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium mb-2">Path (default: /)</label>
                    <Input
                      value={displayRepoPath}
                      onChange={(e) => setRepoPath(e.target.value)}
                      placeholder="/"
                    />
                  </div>
                </div>

                <div className="flex gap-2">
                  {isEditingRepo && (
                    <Button
                      variant="outline"
                      className="flex-1"
                      onClick={() => {
                        setIsEditingRepo(false);
                        setSelectedRepo("");
                        setRepoPath(undefined);
                        setRepoBranch(undefined);
                      }}
                    >
                      Cancel
                    </Button>
                  )}
                  <Button
                    className="flex-1"
                    onClick={handleConnectRepo}
                    disabled={!displaySelectedRepo || setGithubRepoForEstateMutation.isPending}
                  >
                    {setGithubRepoForEstateMutation.isPending ? (
                      <>
                        <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                        {isEditingRepo ? "Updating..." : "Connecting..."}
                      </>
                    ) : (
                      <>
                        {isEditingRepo ? "Update Configuration" : "Connect Repository"}
                        <ArrowRight className="h-4 w-4 ml-2" />
                      </>
                    )}
                  </Button>
                </div>
              </>
            ) : (
              <>
                <ItemDescription>GitHub not connected</ItemDescription>
                <Button
                  onClick={handleConnectGitHub}
                  disabled={startGithubAppInstallFlowMutation.isPending}
                  className="mt-4"
                >
                  {startGithubAppInstallFlowMutation.isPending ? (
                    <>
                      <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                      Connecting...
                    </>
                  ) : (
                    <>
                      Connect GitHub
                      <ArrowRight className="h-4 w-4 ml-2" />
                    </>
                  )}
                </Button>
              </>
            )}
          </ItemContent>
        </Item>
      </div>

      {/* Build History */}
      {connectedRepo && (
        <Item variant="muted">
          <ItemContent className="w-full">
            <div className="flex items-center justify-between mb-4">
              <ItemTitle>Build History</ItemTitle>
              <Button
                onClick={() => {
                  setIsRebuildDialogOpen(true);
                  setRebuildTarget(connectedRepo.branch || "main");
                }}
                variant="outline"
                size="sm"
              >
                <Hammer className="h-4 w-4 mr-2" />
                Trigger Rebuild
              </Button>
            </div>

            {buildsLoading ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="h-8 w-8 animate-spin text-gray-500" />
              </div>
            ) : builds && builds.length > 0 ? (
              <div className="space-y-3">
                {builds.map((build: Build) => {
                  const isExpanded = expandedBuilds.has(build.id);
                  return (
                    <div
                      key={build.id}
                      className="border border-gray-200 dark:border-gray-700 rounded-lg overflow-hidden"
                    >
                      <button
                        onClick={() => toggleBuildExpanded(build.id)}
                        className="w-full px-4 py-3 flex items-center justify-between hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
                      >
                        <div className="flex items-center gap-3 min-w-0 flex-1">
                          {isExpanded ? (
                            <ChevronDown className="h-5 w-5 text-gray-500 flex-shrink-0" />
                          ) : (
                            <ChevronRight className="h-5 w-5 text-gray-500 flex-shrink-0" />
                          )}
                          {getBuildStatusIcon(build.status)}
                          <div className="text-left flex-1 min-w-0 overflow-hidden">
                            <div
                              className="font-medium text-gray-900 dark:text-gray-100 truncate"
                              title={build.commitMessage}
                            >
                              {build.commitMessage}
                            </div>
                            <div className="text-sm text-gray-500 dark:text-gray-400">
                              {build.commitHash.substring(0, 7)} • {formatDate(build.createdAt)}
                            </div>
                          </div>
                        </div>
                        <span
                          className={`px-3 py-1 rounded-full text-sm font-medium ${getBuildStatusColor(build.status)}`}
                        >
                          {build.status.replace("_", " ")}
                        </span>
                      </button>

                      {isExpanded && (
                        <div className="px-4 py-3 bg-gray-50 dark:bg-gray-800 border-t border-gray-200 dark:border-gray-700">
                          <div className="space-y-2 text-sm">
                            <div>
                              <span className="font-medium text-gray-700 dark:text-gray-300">
                                Commit:{" "}
                              </span>
                              <span className="font-mono text-gray-600 dark:text-gray-400">
                                {build.commitHash}
                              </span>
                            </div>
                            {build.completedAt && (
                              <div>
                                <span className="font-medium text-gray-700 dark:text-gray-300">
                                  Completed:{" "}
                                </span>
                                <span className="text-gray-600 dark:text-gray-400">
                                  {formatDate(build.completedAt)}
                                </span>
                              </div>
                            )}
                            <div className="pt-2">
                              <Button
                                onClick={() => handleRebuildCommit(build)}
                                disabled={
                                  triggerRebuildMutation.isPending || build.status === "in_progress"
                                }
                                variant="outline"
                                size="sm"
                              >
                                {triggerRebuildMutation.isPending ? (
                                  <>
                                    <Loader2 className="h-3 w-3 animate-spin mr-2" />
                                    Triggering...
                                  </>
                                ) : (
                                  <>
                                    <RefreshCw className="h-3 w-3 mr-2" />
                                    Rebuild This Commit
                                  </>
                                )}
                              </Button>
                            </div>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            ) : (
              <Empty>
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <Hammer className="h-6 w-6" />
                  </EmptyMedia>
                  <EmptyTitle>No builds yet</EmptyTitle>
                  <EmptyDescription>
                    Push code to your repository to trigger a build.
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            )}
          </ItemContent>
        </Item>
      )}

      {/* Rebuild Dialog */}
      <Dialog
        open={isRebuildDialogOpen}
        onOpenChange={(open) => {
          setIsRebuildDialogOpen(open);
          if (!open) {
            setRebuildTarget("");
            setRebuildTargetType("branch");
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Trigger Manual Rebuild</DialogTitle>
            <DialogDescription>
              Specify a branch or commit hash to rebuild from your connected repository.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                Target Type
              </label>
              <Select
                value={rebuildTargetType}
                onValueChange={(value: "branch" | "commit") => setRebuildTargetType(value)}
                disabled={triggerRebuildMutation.isPending}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="branch">Branch</SelectItem>
                  <SelectItem value="commit">Commit Hash</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                {rebuildTargetType === "branch" ? "Branch Name" : "Commit Hash"}
              </label>
              <Input
                value={rebuildTarget}
                onChange={(e) => setRebuildTarget(e.target.value)}
                placeholder={
                  rebuildTargetType === "branch" ? connectedRepo?.branch || "main" : "abc123def456"
                }
                disabled={triggerRebuildMutation.isPending}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && rebuildTarget.trim()) {
                    handleTriggerRebuild();
                  }
                }}
              />
              <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                {rebuildTargetType === "branch"
                  ? connectedRepo?.branch
                    ? `Currently connected to branch: ${connectedRepo.branch}`
                    : "Enter the branch name to rebuild from"
                  : "Enter the full or short commit hash"}
              </p>
            </div>
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setIsRebuildDialogOpen(false);
                setRebuildTarget("");
                setRebuildTargetType("branch");
              }}
              disabled={triggerRebuildMutation.isPending}
            >
              Cancel
            </Button>
            <Button
              onClick={handleTriggerRebuild}
              disabled={triggerRebuildMutation.isPending || !rebuildTarget.trim()}
            >
              {triggerRebuildMutation.isPending ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  Triggering...
                </>
              ) : (
                "Trigger Rebuild"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export default function ManageEstate() {
  return <EstateContent />;
}
