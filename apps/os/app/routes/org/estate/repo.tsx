import React, { useState } from "react";
import {
  ArrowRight,
  Edit2,
  ChevronDown,
  ChevronRight,
  CheckCircle,
  XCircle,
  RefreshCw,
  Hammer,
  Clock,
  GitBranch,
  Github,
  FileText,
} from "lucide-react";
import { toast } from "sonner";
import { useMutation, useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import type { inferRouterOutputs } from "@trpc/server";
import { data, useLoaderData } from "react-router";
import { Spinner } from "../../../components/ui/spinner.tsx";
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
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "../../../components/ui/accordion.tsx";
import type { AppRouter } from "../../../../backend/trpc/root.ts";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../../../components/ui/card.tsx";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "../../../components/ui/empty.tsx";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldSet,
} from "../../../components/ui/field.tsx";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "../../../components/ui/sheet.tsx";
import { SerializedObjectCodeBlock } from "../../../components/serialized-object-code-block.tsx";
import {
  getGithubInstallationForEstate,
  getGithubInstallationToken,
} from "../../../../backend/integrations/github/github-utils.ts";
import { getDb } from "../../../../backend/db/client.ts";
import type { Route } from "./+types/repo.ts";

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

export async function loader({ params }: Route.LoaderArgs) {
  const { estateId } = params;
  if (!estateId) {
    return data({
      isConnected: false,
      isActive: false,
    });
  }

  const db = getDb();

  const githubInstallation = await getGithubInstallationForEstate(db, estateId);

  if (!githubInstallation) {
    return data({
      isConnected: false,
      isActive: false,
    });
  }

  const token = await getGithubInstallationToken(githubInstallation.accountId);

  if (!token) {
    return data({
      isConnected: true,
      isActive: false,
    });
  }

  return data({
    isConnected: true,
    isActive: true,
  });
}

function EstateContent({
  installationStatus,
}: {
  installationStatus: Awaited<ReturnType<typeof loader>>["data"];
}) {
  const { isConnected, isActive } = installationStatus;

  const [isConfigDialogOpen, setIsConfigDialogOpen] = useState(false);
  const [isIterateConfigSheetOpen, setIsIterateConfigSheetOpen] = useState(false);
  const [selectedRepo, setSelectedRepo] = useState<string>("");
  const [repoPath, setRepoPath] = useState<string | undefined>(undefined);
  const [repoBranch, setRepoBranch] = useState<string | undefined>(undefined);
  const [expandedBuilds, setExpandedBuilds] = useState<Set<string>>(new Set());
  const [isRebuildDialogOpen, setIsRebuildDialogOpen] = useState(false);
  const [rebuildTarget, setRebuildTarget] = useState("");
  const [rebuildTargetType, setRebuildTargetType] = useState<"branch" | "commit">("branch");
  const [advancedValue, setAdvancedValue] = useState<string | undefined>(undefined);

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

  const compiledConfigQuery = useQuery({
    ...trpc.estate.getCompiledIterateConfig.queryOptions({
      estateId: estateId!,
    }),
    enabled: isIterateConfigSheetOpen && Boolean(estateId),
  });
  const iterateConfigData = compiledConfigQuery.data?.config ?? null;
  const iterateConfigUpdatedAt = compiledConfigQuery.data?.updatedAt
    ? new Date(compiledConfigQuery.data.updatedAt).toLocaleString()
    : null;

  // Compute display values for repo fields
  // Use state values if they've been explicitly set (including empty string), otherwise use defaults
  const displaySelectedRepo = selectedRepo || connectedRepo?.repoId?.toString() || "";
  const displayRepoPath = repoPath !== undefined ? repoPath : connectedRepo?.path || "/";
  const displayRepoBranch = repoBranch !== undefined ? repoBranch : connectedRepo?.branch || "main";

  // Auto-open advanced options if path is not "/" or branch is not "main"
  React.useEffect(() => {
    if (displayRepoPath !== "/" || displayRepoBranch !== "main") {
      setAdvancedValue("advanced");
    }
  }, [displayRepoPath, displayRepoBranch]);

  const setGithubRepoForEstateMutation = useMutation(
    trpc.integrations.setGithubRepoForEstate.mutationOptions({}),
  );
  const startGithubAppInstallFlowMutation = useMutation(
    trpc.integrations.startGithubAppInstallFlow.mutationOptions({}),
  );

  const disconnectGithubRepoMutation = useMutation(
    trpc.integrations.disconnectGithubRepo.mutationOptions({}),
  );
  const triggerRebuildMutation = useMutation(trpc.estate.triggerRebuild.mutationOptions({}));

  const handleConnectRepo = (e: React.FormEvent) => {
    e.preventDefault();

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
            connectedRepo
              ? "Configuration updated successfully"
              : "GitHub repository connected successfully",
          );
          setIsConfigDialogOpen(false);
          // Reset form state
          setSelectedRepo("");
          setRepoPath(undefined);
          setRepoBranch(undefined);
          queryClient.invalidateQueries({
            queryKey: trpc.integrations.getGithubRepoForEstate.queryKey({ estateId }),
          });
        },
        onError: () => {
          toast.error(
            connectedRepo
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
    <>
      {/* Top Row - Two Cards Side by Side */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Git Repository Explanation */}
        <Card variant="muted">
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle>Your iterate repo</CardTitle>
              {connectedRepo && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setIsIterateConfigSheetOpen(true)}
                >
                  <FileText className="mr-2 h-4 w-4" />
                  View iterate config
                </Button>
              )}
            </div>
          </CardHeader>
          <CardContent>
            <CardDescription className="space-y-2">
              <p>Your @iterate bot is configured using the files in this repository.</p>
              <p>
                The entry point to everything is your{" "}
                {connectedRepo ? (
                  <a
                    href={`https://github.com/${connectedRepo.repoFullName || connectedRepo.repoName}/blob/${connectedRepo.branch}${connectedRepo.path}iterate.config.ts`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-blue-600 hover:text-blue-800 underline"
                  >
                    <code>iterate.config.ts</code>
                  </a>
                ) : (
                  <code>iterate.config.ts</code>
                )}{" "}
                file.
              </p>
              <p>
                Try{" "}
                {connectedRepo ? (
                  <a
                    href={`https://github.com/${connectedRepo.repoFullName || connectedRepo.repoName}/edit/${connectedRepo.branch}${connectedRepo.path}iterate.config.ts`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-blue-600 hover:text-blue-800 underline"
                  >
                    editing it
                  </a>
                ) : (
                  "editing it"
                )}{" "}
                to change the behaviour of the @iterate bot.
              </p>
            </CardDescription>
          </CardContent>
        </Card>

        {/* Repository Configuration */}
        <Card variant="muted">
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle>Repository Configuration</CardTitle>
              {connectedRepo && (
                <Button variant="outline" size="sm" onClick={() => setIsConfigDialogOpen(true)}>
                  <Edit2 className="h-4 w-4 mr-2" />
                  Edit
                </Button>
              )}
            </div>
          </CardHeader>
          <CardContent>
            {isConnected && isActive && connectedRepo ? (
              <>
                <div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2">
                  <div className="text-sm text-muted-foreground">Repository:</div>
                  <a
                    href={`https://github.com/${connectedRepo.repoFullName || connectedRepo.repoName}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="font-mono text-sm text-blue-600 hover:text-blue-800 underline break-all"
                  >
                    {connectedRepo.repoFullName || connectedRepo.repoName}
                  </a>

                  <div className="text-sm text-muted-foreground">Branch:</div>
                  <span className="font-mono text-sm">{connectedRepo.branch}</span>

                  <div className="text-sm text-muted-foreground">Path:</div>
                  <span className="font-mono text-sm">{connectedRepo.path}</span>
                </div>
              </>
            ) : isConnected && !isActive ? (
              <>
                <CardDescription className="text-amber-600 dark:text-amber-400">
                  Your GIthub App connection has expired or been revoked. You will need to remove
                  the connection and reconnect the repo.
                </CardDescription>
                <div className="flex gap-2 mt-4">
                  <Button
                    onClick={() => {
                      disconnectGithubRepoMutation.mutate({
                        estateId: estateId!,
                        deleteInstallation: true,
                      });
                    }}
                    variant="outline"
                  >
                    Remove and Reconnect
                  </Button>
                </div>
              </>
            ) : repos && repos.length > 0 ? (
              <>
                <CardDescription>
                  Connect your iterate repository to enable automatic builds and deployments.
                </CardDescription>
                <Button onClick={() => setIsConfigDialogOpen(true)} className="mt-4">
                  <GitBranch className="h-4 w-4 mr-2" />
                  Configure Repository
                </Button>
              </>
            ) : (
              <>
                <CardDescription>GitHub not connected</CardDescription>
                <Button
                  onClick={handleConnectGitHub}
                  disabled={startGithubAppInstallFlowMutation.isPending}
                  className="mt-4"
                >
                  {startGithubAppInstallFlowMutation.isPending ? (
                    <>
                      <Spinner className="w-4 h-4 mr-2" />
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
          </CardContent>
        </Card>
      </div>

      {/* Build History */}
      {connectedRepo && (
        <Card variant="muted">
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle>Build History</CardTitle>
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
          </CardHeader>
          <CardContent>
            {buildsLoading ? (
              <div className="flex items-center justify-center py-8">
                <Spinner className="h-8 w-8 text-gray-500" />
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
                                    <Spinner className="h-3 w-3 mr-2" />
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
          </CardContent>
        </Card>
      )}

      <Sheet open={isIterateConfigSheetOpen} onOpenChange={setIsIterateConfigSheetOpen}>
        <SheetContent
          side="right"
          className="max-w-none w-full sm:max-w-none"
          style={{ width: "min(100vw, max(1000px, 70vw))" }}
        >
          <SheetHeader>
            <SheetTitle>Compiled iterate.config.ts</SheetTitle>
            <SheetDescription>
              View the compiled iterate configuration for this estate.
              {iterateConfigUpdatedAt && (
                <span className="mt-1 block text-xs text-muted-foreground">
                  Last updated {iterateConfigUpdatedAt}
                </span>
              )}
            </SheetDescription>
          </SheetHeader>
          <div className="flex flex-1 flex-col min-h-0 px-4 pb-4">
            {compiledConfigQuery.isLoading ? (
              <div className="flex flex-1 items-center justify-center">
                <Spinner className="h-6 w-6" />
              </div>
            ) : compiledConfigQuery.isError ? (
              <div className="flex flex-1 flex-col items-center justify-center text-center text-sm text-muted-foreground">
                <p>
                  Failed to load the iterate config.
                  {compiledConfigQuery.error instanceof Error && (
                    <span className="mt-2 block text-xs text-muted-foreground">
                      {compiledConfigQuery.error.message}
                    </span>
                  )}
                </p>
                <Button
                  variant="outline"
                  size="sm"
                  className="mt-4"
                  onClick={() => compiledConfigQuery.refetch()}
                >
                  <RefreshCw className="mr-2 h-4 w-4" />
                  Retry
                </Button>
              </div>
            ) : iterateConfigData ? (
              <SerializedObjectCodeBlock data={iterateConfigData} className="flex-1 min-h-0" />
            ) : (
              <div className="flex flex-1 items-center justify-center text-center text-sm text-muted-foreground">
                No compiled iterate config available yet.
              </div>
            )}
          </div>
        </SheetContent>
      </Sheet>

      {/* Repository Configuration Dialog */}
      <Dialog
        open={isConfigDialogOpen}
        onOpenChange={(open) => {
          setIsConfigDialogOpen(open);
          if (!open) {
            // Reset form state when dialog closes
            setSelectedRepo("");
            setRepoPath(undefined);
            setRepoBranch(undefined);
            setAdvancedValue(undefined);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {connectedRepo ? "Update Repository Configuration" : "Configure Repository"}
            </DialogTitle>
            <DialogDescription>
              Select a repository and configure the branch and path for your iterate estate.
            </DialogDescription>
          </DialogHeader>

          <form onSubmit={handleConnectRepo}>
            <FieldSet>
              <FieldGroup>
                {/* Repository Select */}
                <Field>
                  <FieldLabel htmlFor="repository">Repository</FieldLabel>
                  <Select
                    value={displaySelectedRepo}
                    onValueChange={setSelectedRepo}
                    disabled={setGithubRepoForEstateMutation.isPending}
                  >
                    <SelectTrigger id="repository">
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
                  <FieldDescription>
                    Choose the GitHub repository that contains your iterate configuration.
                  </FieldDescription>
                </Field>

                {/* Advanced Options */}
                <Accordion
                  type="single"
                  collapsible
                  value={advancedValue}
                  onValueChange={setAdvancedValue}
                >
                  <AccordionItem value="advanced" className="border-none">
                    <AccordionTrigger className="py-2 text-sm text-muted-foreground hover:text-foreground hover:no-underline">
                      Advanced options
                    </AccordionTrigger>
                    <AccordionContent className="space-y-4 pt-2">
                      {/* Branch Input */}
                      <Field>
                        <FieldLabel htmlFor="branch">Branch</FieldLabel>
                        <Input
                          id="branch"
                          value={displayRepoBranch}
                          onChange={(e) => setRepoBranch(e.target.value)}
                          placeholder="main"
                          disabled={setGithubRepoForEstateMutation.isPending}
                        />
                        <FieldDescription>
                          The branch to monitor for changes. Defaults to "main".
                        </FieldDescription>
                      </Field>

                      {/* Path Input */}
                      <Field>
                        <FieldLabel htmlFor="path">Path</FieldLabel>
                        <Input
                          id="path"
                          value={displayRepoPath}
                          onChange={(e) => setRepoPath(e.target.value)}
                          placeholder="/"
                          disabled={setGithubRepoForEstateMutation.isPending}
                        />
                        <FieldDescription>
                          The path to the folder in which your <code>iterate.config.ts</code> file
                          is located. Defaults to <code>/</code>.
                        </FieldDescription>
                      </Field>
                    </AccordionContent>
                  </AccordionItem>
                </Accordion>
              </FieldGroup>
            </FieldSet>

            <DialogFooter className="mt-6 gap-2">
              <Button
                type="button"
                variant="destructive"
                onClick={() => {
                  // TODO: temporary disabled
                  // Upon redirect the estate will be disconnected from GitHub
                  // Which will automatically create a new repo in the estate pool
                  // That is not ideal, so we're temporarily disabling this feature
                  toast.error("This feature is temporarily disabled");
                }}
                disabled={startGithubAppInstallFlowMutation.isPending}
                className="flex-1"
              >
                {startGithubAppInstallFlowMutation.isPending ? (
                  <>
                    <Spinner className="w-4 h-4 mr-2" />
                    Connecting...
                  </>
                ) : (
                  <>
                    <Github className="h-4 w-4 mr-2" />
                    Re-authorize GitHub
                  </>
                )}
              </Button>
              <Button
                type="submit"
                disabled={!displaySelectedRepo || setGithubRepoForEstateMutation.isPending}
                className="flex-1"
              >
                {setGithubRepoForEstateMutation.isPending ? (
                  <>
                    <Spinner className="w-4 h-4 mr-2" />
                    {connectedRepo ? "Updating..." : "Connecting..."}
                  </>
                ) : (
                  <>
                    {connectedRepo ? "Update Configuration" : "Connect Repository"}
                    <ArrowRight className="h-4 w-4 ml-2" />
                  </>
                )}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

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
                  <Spinner className="w-4 h-4 mr-2" />
                  Triggering...
                </>
              ) : (
                "Trigger Rebuild"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

export default function ManageEstate() {
  const installationStatus = useLoaderData<typeof loader>();
  return <EstateContent installationStatus={installationStatus} />;
}
