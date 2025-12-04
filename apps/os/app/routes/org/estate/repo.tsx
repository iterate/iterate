import React, { Suspense, useEffect, useMemo, useRef, useState } from "react";
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
  Github,
  FileText,
  BadgeQuestionMarkIcon,
  PlusIcon,
} from "lucide-react";
import { toast } from "sonner";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { inferRouterOutputs } from "@trpc/server";
import { z } from "zod/v4";
import { createFileRoute } from "@tanstack/react-router";
import { match } from "ts-pattern";
import { pick } from "remeda";
import { Spinner } from "../../../components/ui/spinner.tsx";
import { Button } from "../../../components/ui/button.tsx";
import { Input } from "../../../components/ui/input.tsx";
import { useTRPC } from "../../../lib/trpc.ts";
import { useEstateId, useOrganizationId } from "../../../hooks/use-estate.ts";
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
// Lazy-load IDE (heavy Monaco) to avoid blocking initial page render
const IDELazy = React.lazy(() =>
  import("../../../components/ide.tsx").then((m) => ({ default: m.IDE })),
);
import { type IDEHandle } from "../../../components/ide.tsx";
import {
  getGithubInstallationForEstate,
  getOctokitForInstallation,
} from "../../../../backend/integrations/github/github-utils.ts";
import { authenticatedServerFn } from "../../../lib/auth-middleware.ts";
import { Link } from "../../../components/ui/link.tsx";
import { useSSE, type UseSSEOptions } from "../../../hooks/use-sse.ts";

// Use tRPC's built-in type inference for the build type
type RouterOutputs = inferRouterOutputs<AppRouter>;
type _Build = RouterOutputs["estate"]["getBuilds"][0];
type BuildStatus = _Build["status"] | "timed_out";
type Build = Omit<_Build, "status"> & { status: BuildStatus };

export const estateRepoLoader = authenticatedServerFn
  .inputValidator(z.object({ estateId: z.string() }))
  .handler(async ({ context, data }) => {
    const { estateId } = data;
    const { db } = context.variables;

    const trpc = context.variables.trpcCaller;
    const [githubIntegration, githubRepoResult, githubInstallation] = await Promise.all([
      trpc.integrations.get({ estateId: estateId, providerId: "github-app" }),
      trpc.integrations
        .getGithubRepoForEstate({ estateId: estateId })
        .then((r) => ({ success: true, data: r, error: null }) as const)
        .catch((e) => ({ success: false, data: null, error: String(e.message || e) }) as const),
      getGithubInstallationForEstate(db, estateId),
    ]);

    const authInfo =
      githubInstallation &&
      (await getOctokitForInstallation(githubInstallation.accountId)
        .then((octokit) =>
          octokit.request("GET /app/installations/{installation_id}", {
            installation_id: parseInt(githubInstallation.accountId),
          }),
        )
        .catch());

    const hasActiveInstallation = authInfo?.status === 200 && !authInfo.data.suspended_at;

    return {
      githubRepoResult,
      hasGithubIntegration: githubIntegration.isConnected,
      hasActiveInstallation,
      managedBy: githubRepoResult.data?.managedBy || "iterate",
    };
  });

export const Route = createFileRoute("/_auth.layout/$organizationId/$estateId/repo")({
  component: ManageEstate,
  loader: ({ params }) => estateRepoLoader({ data: { estateId: params.estateId } }),
  head: () => ({
    meta: [
      {
        title: "Manage Estate - Iterate Dashboard",
      },
      {
        name: "description",
        content: "Manage your estate and connect to GitHub",
      },
    ],
  }),
});

function EstateContent({
  installationStatus,
  ideRef,
}: {
  installationStatus: Awaited<ReturnType<typeof estateRepoLoader>>;
  ideRef: React.RefObject<IDEHandle | null>;
}) {
  const [isConfigDialogOpen, setIsConfigDialogOpen] = useState(false);
  const [isIterateConfigSheetOpen, setIsIterateConfigSheetOpen] = useState(false);
  const [selectedRepo, setSelectedRepo] = useState<string>("");
  const [repoPath, setRepoPath] = useState<string | undefined>(undefined);
  const [repoBranch, setRepoBranch] = useState<string | undefined>(undefined);
  const [expandedBuilds, setExpandedBuilds] = useState<Set<string>>(new Set());
  const [isRebuildDialogOpen, setIsRebuildDialogOpen] = useState(false);
  const [rebuildTarget, setRebuildTarget] = useState("");
  const [rebuildTargetType, setRebuildTargetType] = useState<"branch" | "commit">("branch");
  const [advancedValue, setAdvancedValue] = useState<string>();
  const [isLogsSheetOpen, setIsLogsSheetOpen] = useState(false);
  const [logsBuild, setLogsBuild] = useState<Build | null>(null);
  const [isRollbackDialogOpen, setIsRollbackDialogOpen] = useState(false);
  const [rollbackBuild, setRollbackBuild] = useState<Build | null>(null);

  // Get estate ID from URL
  const estateId = useEstateId();
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  const reposQuery = useQuery({
    ...trpc.integrations.listAvailableGithubRepos.queryOptions({
      estateId: estateId,
    }),
    // Only enumerate repos when the config dialog is open and GitHub is connected
    enabled: isConfigDialogOpen && installationStatus.hasGithubIntegration && Boolean(estateId),
    staleTime: 5 * 60 * 1000,
  });
  const repos = reposQuery.data;

  useEffect(() => {
    if (selectedRepo && !repoBranch && repos) {
      setRepoBranch(repos.find((r) => r.id === parseInt(selectedRepo))?.default_branch);
    }
  }, [selectedRepo, repoBranch, repos]);

  const { data: builds, isLoading: buildsLoading } = useQuery(
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

  React.useEffect(() => {
    if (!installationStatus.githubRepoResult.success) return;
    // Preload the IDE chunk; React caches dynamic imports so this is cheap on repeat
    import("../../../components/ide.tsx");
  }, [installationStatus.githubRepoResult.success]);

  React.useEffect(() => {
    if ((repoPath && repoPath !== "/" && repoPath !== ".") || repoBranch !== "main") {
      setAdvancedValue("advanced");
    }
  }, [repoPath, repoBranch]);

  const createIterateManagedGithubRepoMutation = useMutation(
    trpc.integrations.createIterateManagedGithubRepo.mutationOptions({
      onSuccess: () => window.location.reload(),
    }),
  );
  const setGithubRepoForEstateMutation = useMutation(
    trpc.integrations.setGithubRepoForEstate.mutationOptions({}),
  );
  const startGithubAppInstallFlowMutation = useMutation(
    trpc.integrations.startGithubAppInstallFlow.mutationOptions({}),
  );

  const triggerRebuildMutation = useMutation(trpc.estate.triggerRebuild.mutationOptions({}));

  const rollbackToBuildMutation = useMutation(trpc.estate.rollbackToBuild.mutationOptions({}));

  const organizationId = useOrganizationId();

  const handleConnectRepo = (e: React.FormEvent) => {
    e.preventDefault();

    if (!selectedRepo) {
      toast.error("Please select a repository");
      return;
    }
    if (!repoBranch) {
      toast.error("Please choose a branch");
      return;
    }

    setGithubRepoForEstateMutation.mutate(
      {
        estateId: estateId!,
        repoId: parseInt(selectedRepo),
        path: repoPath,
        branch: repoBranch,
      },
      {
        onSuccess: () => {
          toast.success("Configuration updated successfully");
          window.location.reload(); // the invalidateQueries below doesn't seem to be enough
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
          toast.error("Failed to update configuration");
        },
      },
    );
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

  const getBuildStatusIcon = (status: BuildStatus) => {
    switch (status) {
      case "complete":
        return <CheckCircle className="h-5 w-5 text-green-600" />;
      case "failed":
        return <XCircle className="h-5 w-5 text-red-600" />;
      case "in_progress":
        return <RefreshCw className="h-5 w-5 text-blue-600 animate-spin" />;
      case "timed_out":
        return <Clock className="h-5 w-5 text-gray-600" />;
      default:
        status satisfies never;
        return <BadgeQuestionMarkIcon className="h-5 w-5 text-gray-600" />;
    }
  };

  const getBuildStatusColor = (status: BuildStatus) => {
    switch (status) {
      case "complete":
        return "text-green-700 bg-green-50 dark:text-green-400 dark:bg-green-900/20";
      case "failed":
        return "text-red-700 bg-red-50 dark:text-red-400 dark:bg-red-900/20";
      case "in_progress":
        return "text-blue-700 bg-blue-50 dark:text-blue-400 dark:bg-blue-900/20";
      case "timed_out":
        return "text-gray-700 bg-gray-50 dark:text-gray-400 dark:bg-gray-900/20";
      default:
        status satisfies never;
        return "text-gray-700 bg-gray-50 dark:text-gray-400 dark:bg-gray-900/20";
    }
  };

  const getDerivedBuildStatus = (build: _Build): BuildStatus => {
    // Persistent timeout from DB
    const failureReason = build.failureReason as string | undefined;
    if (build.status === "failed" && failureReason === "timeout") return "timed_out";
    return build.status;
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

  const connectedRepo = installationStatus.githubRepoResult.data;

  const repositoryConfigurationDialog = (
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
          <DialogTitle>Update Repository Configuration</DialogTitle>
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
                  value={selectedRepo}
                  onValueChange={setSelectedRepo}
                  disabled={reposQuery.isLoading || setGithubRepoForEstateMutation.isPending}
                >
                  <SelectTrigger id="repository">
                    <SelectValue placeholder="Select a repository" />
                    {reposQuery.isLoading && <Spinner className="h-3 w-3 opacity-60" />}
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
                        value={repoBranch}
                        onChange={(e) => setRepoBranch(e.target.value)}
                        placeholder="main"
                        disabled={setGithubRepoForEstateMutation.isPending}
                      />
                      <FieldDescription>The branch to monitor for changes.</FieldDescription>
                    </Field>

                    {/* Path Input */}
                    <Field>
                      <FieldLabel htmlFor="path">Path</FieldLabel>
                      <Input
                        id="path"
                        value={repoPath}
                        onChange={(e) => setRepoPath(e.target.value)}
                        placeholder="/"
                        disabled={setGithubRepoForEstateMutation.isPending}
                      />
                      <FieldDescription>
                        The path to the folder in which your <code>iterate.config.ts</code> file is
                        located. Defaults to <code>/</code>.
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
              disabled={!selectedRepo || setGithubRepoForEstateMutation.isPending}
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
  );

  if (!installationStatus.githubRepoResult.data && installationStatus.hasGithubIntegration) {
    return (
      <div className="h-[calc(100vh-8rem)] flex items-center justify-center">
        <Button
          variant="outline"
          size="sm"
          onClick={() => setIsConfigDialogOpen(true)}
          disabled={!installationStatus.hasGithubIntegration}
        >
          Select GitHub Repository
        </Button>
        {repositoryConfigurationDialog}
      </div>
    );
  }

  if (!connectedRepo) {
    const problemMessage = installationStatus.githubRepoResult.error || "No repository connected.";
    const connectMessage = installationStatus.hasGithubIntegration
      ? `Try disconnecting and reconnecting GitHub`
      : `Connect GitHub`;
    return (
      <div className="h-[calc(100vh-8rem)] flex items-center justify-center">
        <span>
          {problemMessage}{" "}
          <Link to="/$organizationId/$estateId/integrations" params={{ organizationId, estateId }}>
            {connectMessage}
          </Link>
          <div className="flex items-center gap-2 mt-4">
            {" or "}
            <Button
              variant="outline"
              size="sm"
              onClick={() => createIterateManagedGithubRepoMutation.mutate({ estateId })}
              disabled={createIterateManagedGithubRepoMutation.isPending}
            >
              <PlusIcon className="h-4 w-4 mr-2" />
              Create Iterate Managed Repository
            </Button>
          </div>
        </span>
      </div>
    );
  }

  return (
    <>
      {/* Top Row - Two Cards Side by Side */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Git Repository Explanation */}
        <Card variant="muted">
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle>Your iterate repo</CardTitle>
              <Button variant="outline" size="sm" onClick={() => setIsIterateConfigSheetOpen(true)}>
                <FileText className="mr-2 h-4 w-4" />
                View iterate config
              </Button>
            </div>
          </CardHeader>
          <CardContent>
            <CardDescription className="space-y-2">
              <p>Your @iterate bot is configured using the files in this repository.</p>
              <p>
                The entry point to everything is your{" "}
                <a
                  href={`${connectedRepo.htmlUrl}/tree/${connectedRepo.branch}${connectedRepo.path}iterate.config.ts`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-blue-600 hover:text-blue-800 underline"
                >
                  <code>iterate.config.ts</code>
                </a>{" "}
                file.
              </p>
              <p>Try editing it below to change the behaviour of the @iterate bot.</p>
            </CardDescription>
          </CardContent>
        </Card>

        <Card variant="muted">
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle>Repository Configuration</CardTitle>
              {connectedRepo && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setIsConfigDialogOpen(true)}
                  disabled={!installationStatus.hasGithubIntegration}
                >
                  <Edit2 className="h-4 w-4 mr-2" />
                  Edit
                </Button>
              )}
            </div>
          </CardHeader>
          <CardContent>
            {match(installationStatus)
              .with({ managedBy: "user", hasActiveInstallation: true }, () => {
                // happiest path
                return (
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

                      {connectedRepo.path && (
                        <>
                          <div className="text-sm text-muted-foreground">Path:</div>
                          <span className="font-mono text-sm">{connectedRepo.path}</span>
                        </>
                      )}
                    </div>
                  </>
                );
              })
              .with({ managedBy: "user", hasActiveInstallation: false }, () => {
                return (
                  <>
                    <CardDescription className="text-amber-600 dark:text-amber-400">
                      Your Github App connection has expired, suspended or been revoked. You will
                      need to remove the connection and reconnect the repo.
                    </CardDescription>
                    <div className="flex gap-2 mt-4">
                      <Link
                        to="/$organizationId/$estateId/integrations"
                        params={{ organizationId, estateId }}
                      >
                        Manage Integrations
                      </Link>
                    </div>
                  </>
                );
              })
              .with({ managedBy: "iterate", hasGithubIntegration: true }, () => {
                // todo: transfer repository button? copy config to a new repo? not sure what you can do via API though
                // story for "upgrade from iterate to user managed" is bad
                return "This repository is managed by Iterate. To use your own, click the Edit button above.";
              })
              .with({ managedBy: "iterate", hasGithubIntegration: false }, () => {
                return (
                  <>
                    This repository is managed by Iterate,{" "}
                    <Link
                      to="/$organizationId/$estateId/integrations"
                      params={{ organizationId, estateId }}
                    >
                      connect GitHub
                    </Link>{" "}
                    to use your own repository.
                  </>
                );
              })
              .exhaustive()}
          </CardContent>
        </Card>
      </div>

      <Suspense
        fallback={
          <div className="h-[calc(100vh-8rem)] flex items-center justify-center">
            <Spinner className="h-6 w-6" />
          </div>
        }
      >
        <IDELazy ref={ideRef} />
      </Suspense>

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
                {builds.map((build) => {
                  const derivedStatus = getDerivedBuildStatus(build);
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
                            <ChevronDown className="h-5 w-5 text-gray-500 shrink-0" />
                          ) : (
                            <ChevronRight className="h-5 w-5 text-gray-500 shrink-0" />
                          )}
                          {getBuildStatusIcon(derivedStatus)}
                          <div className="text-left flex-1 min-w-0 overflow-hidden">
                            <div
                              className="font-medium text-gray-900 dark:text-gray-100 truncate"
                              title={build.commitMessage}
                            >
                              {build.commitMessage}
                              {build.isActive && <>{" [active]"}</>}
                            </div>
                            <div className="text-sm text-gray-500 dark:text-gray-400">
                              {build.commitHash.substring(0, 7)} • {formatDate(build.createdAt)}
                            </div>
                          </div>
                        </div>
                        <span
                          className={`px-3 py-1 rounded-full text-sm font-medium ${getBuildStatusColor(derivedStatus)}`}
                        >
                          {derivedStatus.replace("_", " ")}
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
                            <div className="pt-2 flex items-center gap-2">
                              <Button
                                onClick={() => handleRebuildCommit(build)}
                                disabled={
                                  triggerRebuildMutation.isPending ||
                                  derivedStatus === "in_progress"
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
                              <Button
                                onClick={() => {
                                  setLogsBuild(build);
                                  setIsLogsSheetOpen(true);
                                }}
                                variant="outline"
                                size="sm"
                              >
                                View Logs
                              </Button>
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() => {
                                  setRollbackBuild(build);
                                  setIsRollbackDialogOpen(true);
                                }}
                              >
                                Rollback...
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

      {/* Build Logs Sheet */}
      <Sheet
        open={isLogsSheetOpen}
        onOpenChange={(open) => {
          setIsLogsSheetOpen(open);
          if (!open) setLogsBuild(null);
        }}
      >
        <SheetContent
          side="right"
          className="max-w-none w-full sm:max-w-none"
          style={{ width: "min(100vw, max(1000px, 70vw))" }}
        >
          <SheetHeader>
            <SheetTitle>
              {logsBuild
                ? `Compiled logs for ${logsBuild.commitHash.substring(0, 7)}`
                : "Build logs"}
            </SheetTitle>
            <SheetDescription>
              Streams stdout and stderr as they arrive. Past logs load first.
            </SheetDescription>
          </SheetHeader>
          <div className="flex flex-1 min-h-0 p-4">
            {logsBuild ? (
              <BuildLogsViewer estateId={estateId!} build={logsBuild} />
            ) : (
              <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
                Select a build to view logs
              </div>
            )}
          </div>
        </SheetContent>
      </Sheet>

      {/* Repository Configuration Dialog */}
      {repositoryConfigurationDialog}

      {/* Rollback Dialog */}
      <Dialog
        open={isRollbackDialogOpen}
        onOpenChange={(open) => {
          setIsRollbackDialogOpen(open);
          if (!open) {
            setRollbackBuild(null);
          }
        }}
      >
        <DialogContent
          className="max-h-[90vh] flex flex-col sm:max-w-[90vw]"
          style={{ width: "min(90vw, 1400px)" }}
        >
          <DialogHeader>
            <DialogTitle>Rollback to Build</DialogTitle>
            <DialogDescription>
              This will roll your bot back to its state as of this build. The configuration shown
              below will be restored to your estate.
            </DialogDescription>
          </DialogHeader>
          <div className="flex-1 min-h-0 overflow-hidden flex flex-col">
            {rollbackBuild && (
              <SerializedObjectCodeBlock
                data={pick(rollbackBuild, [
                  "id",
                  "commitHash",
                  "commitMessage",
                  "status",
                  "files",
                  "config",
                ])}
                className="flex-1 min-h-0"
              />
            )}
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setIsRollbackDialogOpen(false);
                setRollbackBuild(null);
              }}
              disabled={rollbackToBuildMutation.isPending}
            >
              Cancel
            </Button>
            <Button
              variant="outline"
              onClick={() => {
                if (rollbackBuild && rollbackBuild.files && ideRef.current) {
                  // Convert build.files array to Record<string, string> format
                  const record = Object.fromEntries(
                    rollbackBuild.files.map((file) => [file.path, file.content]),
                  );

                  const { branch } = ideRef.current.updateLocalEdits(record);
                  toast.success(
                    `Files from this build have been loaded into the IDE. Go to the Git repository tab and click "Push to ${branch}" to apply them.`,
                    { duration: 8000 },
                  );
                  setIsRollbackDialogOpen(false);
                  setRollbackBuild(null);
                }
              }}
              disabled={!rollbackBuild || !rollbackBuild.files?.length || !ideRef.current}
            >
              Re-apply changes
            </Button>
            <Button
              onClick={() => {
                if (rollbackBuild) {
                  rollbackToBuildMutation.mutate(
                    { estateId, buildId: rollbackBuild.id },
                    {
                      onSuccess: ({ updated }) => {
                        if (updated === 0) {
                          toast.error("Failed to rollback");
                          return;
                        }
                        toast.success("Rollback completed successfully");
                        setIsRollbackDialogOpen(false);
                        setRollbackBuild(null);
                        queryClient.invalidateQueries({
                          queryKey: trpc.estate.getBuilds.queryKey({ estateId }),
                        });
                      },
                      onError: (error) => {
                        toast.error(error.message || "Failed to rollback");
                      },
                    },
                  );
                }
              }}
              disabled={
                !rollbackBuild ||
                rollbackBuild.status !== "complete" ||
                rollbackBuild.isActive ||
                rollbackToBuildMutation.isPending
              }
            >
              {rollbackToBuildMutation.isPending ? (
                <>
                  <Spinner className="w-4 h-4 mr-2" />
                  Rolling back...
                </>
              ) : (
                "Rollback"
              )}
            </Button>
          </DialogFooter>
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
  const installationStatus = Route.useLoaderData();
  const ideRef = useRef<IDEHandle>(null);

  return <EstateContent installationStatus={installationStatus} ideRef={ideRef} />;
}

function BuildLogsViewer({ estateId, build }: { estateId: string; build: Build }) {
  const [lines, setLines] = useState<
    Array<{
      ts: number;
      stream: "stdout" | "stderr" | (string & {});
      message: string;
    }>
  >([]);
  const [showStdout, setShowStdout] = useState(true);
  const [showStderr, setShowStderr] = useState(true);
  const [follow, setFollow] = useState(true);
  const [connectionState, setConnectionState] = useState<
    "connecting" | "open" | "closed" | "error"
  >("connecting");
  const scrollerRef = useRef<HTMLDivElement | null>(null);

  const options = useMemo(
    () =>
      ({
        async onopen() {
          setConnectionState("open");
        },
        onerror(err) {
          console.error(err);
          setConnectionState("error");
        },
        onclose() {
          setConnectionState("closed");
        },
        onmessage(ev) {
          setLines((prev) => [
            ...prev,
            {
              ts: Date.now(),
              stream: ev.event,
              message: ev.data,
            },
          ]);
        },
      }) satisfies UseSSEOptions,
    [],
  );

  useSSE(`/api/estate/${estateId}/builds/${build.id}/sse`, options);

  React.useEffect(() => {
    if (!follow) return;
    const el = scrollerRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [lines, follow]);

  const filtered = lines.filter((l) => (l.stream === "stdout" ? showStdout : showStderr));

  return (
    <div className="flex flex-col w-full">
      <div className="flex items-center gap-2 pb-3">
        <Button
          variant={showStdout ? "default" : "outline"}
          size="sm"
          onClick={() => setShowStdout((v) => !v)}
        >
          stdout
        </Button>
        <Button
          variant={showStderr ? "default" : "outline"}
          size="sm"
          onClick={() => setShowStderr((v) => !v)}
        >
          stderr
        </Button>
        <Button variant="outline" size="sm" onClick={() => setFollow((v) => !v)}>
          {follow ? "Unfollow" : "Follow"}
        </Button>
        <Button variant="outline" size="sm" onClick={() => setLines([])}>
          Clear
        </Button>
        {connectionState === "open" ? (
          <span className="text-xs text-green-600 dark:text-green-400">Connected</span>
        ) : connectionState === "error" ? (
          <span className="text-xs text-red-600 dark:text-red-400">Error</span>
        ) : connectionState === "closed" ? (
          <span className="text-xs text-muted-foreground">Closed</span>
        ) : (
          <span className="text-xs text-muted-foreground">Connecting…</span>
        )}
      </div>
      <div
        ref={scrollerRef}
        className="flex-1 min-h-0 rounded-md border border-gray-200 dark:border-gray-800 bg-black/90 text-white p-3 overflow-auto"
      >
        <pre className="text-xs leading-5 font-mono whitespace-pre-wrap">
          {filtered.map((l, idx) => (
            <div key={idx} className={l.stream === "stderr" ? "text-red-400" : "text-gray-200"}>
              <span className="text-gray-500">[{new Date(l.ts).toLocaleTimeString()}]</span>{" "}
              <span className="uppercase text-[10px] px-1 rounded-sm bg-white/10 text-white/80">
                {l.stream}
              </span>{" "}
              <span>{l.message}</span>
            </div>
          ))}
          {filtered.length === 0 && (
            <div className="text-xs text-muted-foreground">No logs found</div>
          )}
        </pre>
      </div>
    </div>
  );
}
