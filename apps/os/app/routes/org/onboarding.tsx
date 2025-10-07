import { Suspense, useState, useEffect, useMemo } from "react";
import { ArrowRight, Check, CheckCircle, ChevronDown, Github, Loader2 } from "lucide-react";
import { redirect, useLoaderData, useSearchParams } from "react-router";
import { asc, eq } from "drizzle-orm";
import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { getDb } from "../../../backend/db/client.ts";
import { estate } from "../../../backend/db/schema.ts";
import { Button } from "../../components/ui/button.tsx";
import { Input } from "../../components/ui/input.tsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select.tsx";
import { Badge } from "../../components/ui/badge.tsx";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "../../components/ui/collapsible.tsx";
import { useTRPC } from "../../lib/trpc.ts";
import { authClient } from "../../lib/auth-client.ts";
import type { Route } from "./+types/onboarding.ts";

export async function loader({ params }: Route.LoaderArgs) {
  const { organizationId } = params;

  // Parent loader already checked session and organization access
  // We just need to get the first estate for this organization
  if (!organizationId) {
    throw redirect("/");
  }
  const db = getDb();
  const firstEstate = await db.query.estate.findFirst({
    where: eq(estate.organizationId, organizationId),
    orderBy: asc(estate.createdAt),
  });

  if (!firstEstate) {
    throw new Error(`The organization ${organizationId} has no estates, this should never happen.`);
  }
  return {
    organizationId,
    estateId: firstEstate.id,
  };
}

function SetupIterateRepoStep({ onComplete }: { onComplete: () => void }) {
  return (
    <form
      className="space-y-6"
      onSubmit={(event) => {
        event.preventDefault();
        onComplete();
      }}
    >
      <div className="space-y-2">
        <p className="text-xs text-muted-foreground">Step 2 of 4</p>
        <h2 className="text-lg font-semibold">Set up your iterate repo</h2>
      </div>

      <div className="space-y-4 text-sm text-muted-foreground">
        <p>
          Go to{" "}
          <a
            href="https://github.com/iterate-com/estate-template"
            target="_blank"
            rel="noreferrer"
            className="underline"
          >
            github.com/iterate-com/estate-template
          </a>{" "}
          and create your own repository from this template.
        </p>
        <img
          src="/clone-estate-template.png"
          alt="Create from template screenshot"
          className="w-full rounded border bg-background"
        />
      </div>

      <div className="flex justify-end">
        <Button type="submit" autoFocus>
          <Check className="mr-2 h-4 w-4" /> I've set up my iterate repo
        </Button>
      </div>
    </form>
  );
}

function OrganizationNameStep({
  organizationId,
  onComplete,
}: {
  organizationId: string;
  onComplete: () => void;
}) {
  const trpc = useTRPC();
  const { data: organization } = useSuspenseQuery(
    trpc.organization.get.queryOptions({ organizationId }),
  );

  const [organizationName, setOrganizationName] = useState(() => organization.name);
  const [error, setError] = useState<string | null>(null);

  const updateOrganization = useMutation(
    trpc.organization.updateName.mutationOptions({
      onSuccess: () => {
        setError(null);
        onComplete();
      },
      onError: (mutationError) => {
        setError(mutationError.message);
      },
    }),
  );

  return (
    <form
      className="space-y-6"
      onSubmit={async (event) => {
        event.preventDefault();
        setError(null);
        const trimmedName = organizationName.trim();
        if (!trimmedName) {
          setError("Organization name is required");
          return;
        }
        await updateOrganization.mutateAsync({
          organizationId,
          name: trimmedName,
        });
      }}
    >
      <div className="space-y-2">
        <p className="text-xs text-muted-foreground">Step 1 of 4</p>
        <h2 className="text-lg font-semibold">Confirm organization name</h2>
      </div>
      <div className="space-y-4">
        <Input
          value={organizationName}
          onChange={(event) => {
            setOrganizationName(event.target.value);
            setError(null);
          }}
          disabled={updateOrganization.isPending}
          autoFocus
          onFocus={(event) => {
            event.currentTarget.select();
          }}
        />
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
      </div>
      <div className="flex justify-end">
        <Button type="submit" disabled={updateOrganization.isPending}>
          {updateOrganization.isPending ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Confirming
            </>
          ) : (
            <>
              <Check className="mr-2 h-4 w-4" />
              Confirm
            </>
          )}
        </Button>
      </div>
    </form>
  );
}

function ConnectGithubStep({
  estateId,
  organizationId,
  onComplete,
}: {
  estateId: string;
  organizationId: string;
  onComplete: () => void;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  const { data: githubRepo } = useSuspenseQuery(
    trpc.integrations.getGithubRepoForEstate.queryOptions({ estateId }),
  );
  const { data: availableRepos } = useSuspenseQuery(
    trpc.integrations.listAvailableGithubRepos.queryOptions({ estateId }),
  );

  const [selectedRepoId, setSelectedRepoId] = useState(() => githubRepo?.repoId?.toString() ?? "");
  const [repoBranch, setRepoBranch] = useState(() => githubRepo?.branch ?? "main");
  const [repoPath, setRepoPath] = useState(() => githubRepo?.path ?? "/");
  const [feedback, setFeedback] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isAdvancedOpen, setIsAdvancedOpen] = useState(false);

  const repoOptions = useMemo(() => availableRepos ?? [], [availableRepos]);
  const hasAvailableRepos = repoOptions.length > 0;

  // Automatically refresh available repos when returning from GitHub installation
  useEffect(() => {
    if (!hasAvailableRepos) {
      queryClient.invalidateQueries({
        queryKey: trpc.integrations.listAvailableGithubRepos.queryKey({ estateId }),
      });
    }
  }, [hasAvailableRepos, queryClient, trpc.integrations.listAvailableGithubRepos, estateId]);

  const startGithubInstall = useMutation(
    trpc.integrations.startGithubAppInstallFlow.mutationOptions({}),
  );
  const setGithubRepo = useMutation(
    trpc.integrations.setGithubRepoForEstate.mutationOptions({
      onSuccess: (_data, variables) => {
        setFeedback("GitHub repository connected");
        setError(null);
        setSelectedRepoId(String(variables.repoId));
        setRepoBranch(variables.branch ?? "main");
        setRepoPath(variables.path ?? "/");
        queryClient.invalidateQueries({
          queryKey: trpc.integrations.getGithubRepoForEstate.queryKey({ estateId }),
        });
        queryClient.invalidateQueries({
          queryKey: trpc.integrations.listAvailableGithubRepos.queryKey({ estateId }),
        });
        // Redirect to slack step
        window.location.href = `/${organizationId}/onboarding?step=slack`;
      },
      onError: (mutationError) => {
        setFeedback(null);
        setError(mutationError.message);
      },
    }),
  );
  const disconnectGithubRepo = useMutation(
    trpc.integrations.disconnectGithubRepo.mutationOptions({
      onSuccess: () => {
        setFeedback("GitHub connection removed");
        setError(null);
        setSelectedRepoId("");
        setRepoBranch("main");
        setRepoPath("/");
        queryClient.invalidateQueries({
          queryKey: trpc.integrations.getGithubRepoForEstate.queryKey({ estateId }),
        });
        queryClient.invalidateQueries({
          queryKey: trpc.integrations.listAvailableGithubRepos.queryKey({ estateId }),
        });
      },
      onError: (mutationError) => {
        setFeedback(null);
        setError(mutationError.message);
      },
    }),
  );

  const handleStartGithubInstall = async () => {
    const callbackURL = `/${organizationId}/onboarding?step=github`;
    const { installationUrl } = await startGithubInstall.mutateAsync({
      estateId,
      callbackURL,
    });
    window.location.href = installationUrl.toString();
  };

  const saveGithubConfiguration = async () => {
    setFeedback(null);
    setError(null);

    if (!selectedRepoId) {
      setError("Select a repository to continue");
      return;
    }

    await setGithubRepo.mutateAsync({
      estateId,
      repoId: Number(selectedRepoId),
      branch: repoBranch.trim() || undefined,
      path: repoPath.trim() || undefined,
    });
  };
  const handleSaveConfigurationSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    await saveGithubConfiguration();
  };

  const handleDisconnect = async () => {
    await disconnectGithubRepo.mutateAsync({ estateId });
  };

  const isConnected = Boolean(githubRepo);
  const repoLabel = githubRepo
    ? (githubRepo.repoFullName ?? githubRepo.repoName ?? `Repository #${githubRepo.repoId}`)
    : "";

  // Auto-select a single available repo (e.g., right after GitHub App installation)
  useEffect(() => {
    if (!selectedRepoId && repoOptions.length === 1) {
      setSelectedRepoId(repoOptions[0].id.toString());
    }
  }, [selectedRepoId, repoOptions]);

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <p className="text-xs text-muted-foreground">Step 3 of 4</p>
        <h2 className="text-lg font-semibold">Give iterate access to the repo</h2>
      </div>
      <div className="space-y-4">
        {isConnected ? (
          <div className="space-y-2 text-sm text-muted-foreground">
            <div className="flex items-center gap-2">
              <CheckCircle className="h-4 w-4 text-green-600" />
              <span>Connected to {repoLabel}</span>
            </div>
            <div className="flex flex-wrap gap-4">
              <span>
                Branch: <span className="font-mono">{githubRepo?.branch ?? "main"}</span>
              </span>
              <span>
                Path: <span className="font-mono">{githubRepo?.path ?? "/"}</span>
              </span>
            </div>
          </div>
        ) : (
          <>
            <p className="text-sm text-muted-foreground">
              You’ll install the iterate GitHub App and then select the repository you just created.
              If there’s only one available, we’ll select it for you automatically.
            </p>

            {hasAvailableRepos ? (
              <form className="space-y-4" onSubmit={handleSaveConfigurationSubmit}>
                <div className="space-y-2">
                  <label className="text-sm font-medium text-foreground">Repository</label>
                  <Select value={selectedRepoId} onValueChange={setSelectedRepoId}>
                    <SelectTrigger>
                      <SelectValue placeholder="Select a repository" />
                    </SelectTrigger>
                    <SelectContent>
                      {repoOptions.map((repo) => (
                        <SelectItem key={repo.id} value={repo.id.toString()}>
                          {repo.full_name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <Collapsible open={isAdvancedOpen} onOpenChange={setIsAdvancedOpen}>
                  <CollapsibleTrigger asChild>
                    <Button
                      variant="ghost"
                      className="flex items-center gap-2 p-0 h-auto font-normal text-sm text-muted-foreground hover:text-foreground"
                    >
                      Advanced settings
                      <ChevronDown
                        className={`h-4 w-4 transition-transform ${isAdvancedOpen ? "rotate-180" : ""}`}
                      />
                    </Button>
                  </CollapsibleTrigger>
                  <CollapsibleContent className="space-y-4 mt-4">
                    <p className="text-xs text-muted-foreground">
                      These settings are not normally necessary. Most projects work with the default
                      branch (main) and root path (/).
                    </p>
                    <div className="grid gap-4 md:grid-cols-2">
                      <div className="space-y-2">
                        <label className="text-sm font-medium text-foreground">Branch</label>
                        <Input
                          value={repoBranch}
                          onChange={(event) => setRepoBranch(event.target.value)}
                          placeholder="main"
                        />
                      </div>
                      <div className="space-y-2">
                        <label className="text-sm font-medium text-foreground">Path</label>
                        <Input
                          value={repoPath}
                          onChange={(event) => setRepoPath(event.target.value)}
                          placeholder="/"
                        />
                      </div>
                    </div>
                    <Button
                      type="button"
                      variant="outline"
                      onClick={handleStartGithubInstall}
                      disabled={startGithubInstall.isPending}
                    >
                      {startGithubInstall.isPending ? (
                        <>
                          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                          Opening GitHub
                        </>
                      ) : (
                        <>
                          <Github className="mr-2 h-4 w-4" />
                          Reconnect GitHub
                        </>
                      )}
                    </Button>
                  </CollapsibleContent>
                </Collapsible>

                {/* Hidden submit to allow Enter from inputs/selects to submit */}
                <button type="submit" className="hidden" aria-hidden />
              </form>
            ) : (
              <p className="text-sm text-muted-foreground">
                Install the iterate GitHub App to choose a repository for your first estate.
              </p>
            )}
          </>
        )}
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
        {feedback ? <p className="text-sm text-muted-foreground">{feedback}</p> : null}
      </div>
      <div className="flex justify-between">
        {isConnected ? (
          <>
            <Button
              variant="outline"
              onClick={handleDisconnect}
              disabled={disconnectGithubRepo.isPending}
            >
              {disconnectGithubRepo.isPending ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : null}
              Disconnect
            </Button>
            <Button onClick={onComplete} autoFocus>
              Next: Connect Slack
              <ArrowRight className="ml-2 h-4 w-4" />
            </Button>
          </>
        ) : (
          <>
            <div />
            {!hasAvailableRepos ? (
              <Button
                onClick={handleStartGithubInstall}
                disabled={startGithubInstall.isPending}
                autoFocus
              >
                {startGithubInstall.isPending ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Opening GitHub
                  </>
                ) : (
                  <>
                    <Github className="mr-2 h-4 w-4" />
                    Install GitHub app
                  </>
                )}
              </Button>
            ) : hasAvailableRepos ? (
              <Button
                onClick={() => void saveGithubConfiguration()}
                disabled={setGithubRepo.isPending || !selectedRepoId}
                autoFocus
              >
                {setGithubRepo.isPending ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Connecting repository
                  </>
                ) : (
                  <>
                    <Github className="mr-2 h-4 w-4" />
                    Connect repository
                  </>
                )}
              </Button>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}

function SlackStep({ estateId, organizationId }: { estateId: string; organizationId: string }) {
  const trpc = useTRPC();
  const { data: integrations } = useSuspenseQuery(
    trpc.integrations.list.queryOptions({ estateId }),
  );

  const slackIntegration = integrations.oauthIntegrations.find(
    (integration) => integration.id === "slack-bot",
  );
  const isConnected = slackIntegration?.isConnected ?? false;

  const [error, setError] = useState<string | null>(null);

  const connectSlack = useMutation({
    mutationFn: async () => {
      const callbackURL = `/${organizationId}/onboarding?step=slack&success=true`;
      const result = await authClient.integrations.link.slackBot({
        estateId,
        callbackURL,
      });
      window.location.href = result.url.toString();
      return result;
    },
  });

  const handleConnect = async () => {
    setError(null);
    try {
      await connectSlack.mutateAsync();
    } catch (mutationError) {
      setError(mutationError instanceof Error ? mutationError.message : "Failed to connect Slack");
    }
  };

  const handleOpenSlack = () => {
    window.open("slack://open", "_blank");
  };

  const handleComplete = () => {
    window.location.href = `/${organizationId}/${estateId}`;
  };

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <p className="text-xs text-muted-foreground">Step 4 of 4</p>
        <h2 className="text-lg font-semibold">Connect Slack</h2>
      </div>
      <div className="space-y-4">
        <div className="space-y-2 text-sm text-muted-foreground">
          <div className="flex items-center gap-3">
            <div className="flex h-8 w-8 items-center justify-center rounded border bg-background">
              <img src="/slack.svg" alt="Slack" className="h-4 w-4" />
            </div>
            <span>Use Slack to talk to iterate.</span>
          </div>
          <p>
            Mention
            <Badge variant="secondary" className="mx-2 font-mono">
              @iterate
            </Badge>
            in Slack to start working with the agent team.
          </p>
        </div>
        {isConnected ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <CheckCircle className="h-4 w-4 text-green-600" />
            <span>Slack is connected</span>
          </div>
        ) : null}
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
      </div>
      <div className="flex justify-between">
        {isConnected ? (
          <>
            <Button variant="outline" onClick={handleOpenSlack}>
              Open Slack
            </Button>
            <Button onClick={handleComplete}>
              Complete setup
              <ArrowRight className="ml-2 h-4 w-4" />
            </Button>
          </>
        ) : (
          <>
            <div />
            <Button onClick={handleConnect} disabled={connectSlack.isPending}>
              {connectSlack.isPending ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Connecting Slack
                </>
              ) : (
                "Connect Slack"
              )}
            </Button>
          </>
        )}
      </div>
    </div>
  );
}

export default function OrganizationOnboarding({ params }: Route.ComponentProps) {
  const { organizationId } = params;
  const { estateId } = useLoaderData<typeof loader>();
  const [searchParams] = useSearchParams();
  const urlStep = searchParams.get("step");

  const [currentStep, setCurrentStep] = useState<"setup" | "name" | "github" | "slack">(() => {
    if (urlStep === "slack") return "slack";
    if (urlStep === "github") return "github";
    if (urlStep === "setup") return "setup";
    return "name";
  });

  if (!organizationId) {
    return null;
  }

  return (
    <main className="min-h-screen w-full flex items-center justify-center p-6">
      <div className="w-full max-w-2xl">
        <Suspense
          fallback={
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          }
        >
          <div className={currentStep === "name" ? "" : "hidden"}>
            <OrganizationNameStep
              organizationId={organizationId}
              onComplete={() => setCurrentStep("setup")}
            />
          </div>
          <div className={currentStep === "setup" ? "" : "hidden"}>
            <SetupIterateRepoStep onComplete={() => setCurrentStep("github")} />
          </div>
          <div className={currentStep === "github" ? "" : "hidden"}>
            <ConnectGithubStep
              estateId={estateId}
              organizationId={organizationId}
              onComplete={() => setCurrentStep("slack")}
            />
          </div>
          <div className={currentStep === "slack" ? "" : "hidden"}>
            <SlackStep estateId={estateId} organizationId={organizationId} />
          </div>
        </Suspense>
      </div>
    </main>
  );
}
