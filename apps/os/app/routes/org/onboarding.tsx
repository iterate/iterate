import { useState, useMemo } from "react";
import { ArrowRight, ArrowLeft, CheckCircle, ChevronDown } from "lucide-react";
import { redirect, useLoaderData, useNavigate, useParams, useRouteLoaderData } from "react-router";
import { asc, eq } from "drizzle-orm";
import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { toast } from "sonner";
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
import { Card, CardContent } from "../../components/ui/card.tsx";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "../../components/ui/collapsible.tsx";
import { Spinner } from "../../components/ui/spinner.tsx";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "../../components/ui/alert-dialog.tsx";
import { useTRPC } from "../../lib/trpc.ts";
import type { Route } from "./+types/onboarding.ts";
import type { loader as orgLoader } from "./loader.tsx";

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

type StepProps = {
  organizationId: string;
  estateId: string;
  goTo: (step: string) => void;
  goBack: () => void;
};

function SetupIterateRepoStep({ goTo, goBack }: StepProps) {
  const [isDialogOpen, setIsDialogOpen] = useState(false);

  const handleCreateRepo = () => {
    setIsDialogOpen(false);
    window.open(
      "https://github.com/new?template_name=estate-template&template_owner=iterate",
      "_blank",
      "noopener,noreferrer",
    );
    goTo("3");
  };

  return (
    <div className="space-y-8">
      <div className="space-y-3">
        <p className="text-muted-foreground">Step 2 of 3</p>
        <h2 className="text-2xl font-semibold">Set up your iterate repo in GitHub</h2>
      </div>

      <div className="grid gap-8 md:grid-cols-2">
        <div className="space-y-4 text-muted-foreground">
          <p>
            This repo will contain company-wide rules, tools, workflows, memories that your new AI
            coworker will follow.
          </p>
          <p>Soon, @iterate will be able to update the repo and improve itself over time.</p>
          <p>
            The repository is "just typescript", so you can play around with how you want to lay it
            out and coding agents will be able to operate in it.
          </p>
        </div>

        <img
          src="/clone-estate-template.gif"
          alt="Create from template animation"
          className="w-full rounded border"
        />
      </div>

      <div className="flex justify-between items-center pt-4">
        <Button variant="ghost" onClick={goBack}>
          <ArrowLeft className="mr-2 h-4 w-4" />
          Back
        </Button>
        <AlertDialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
          <AlertDialogTrigger asChild>
            <Button>
              Clone template repo
              <ArrowRight className="ml-2 h-4 w-4" />
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Remember to come back here</AlertDialogTitle>
              <AlertDialogDescription>
                <p>
                  After you create the repo in GitHub, you have to come back to this tab to give us
                  access to the repo.
                </p>
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogAction onClick={handleCreateRepo}>OK - I will be back</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </div>
  );
}

function OrganizationNameStep({ organizationId, goTo }: StepProps) {
  const trpc = useTRPC();
  const loaderData = useRouteLoaderData<typeof orgLoader>("routes/org/loader");
  const orgQuery = trpc.organization.get.queryOptions({ organizationId });
  const { data: organization } = useSuspenseQuery({
    ...orgQuery,
    initialData: loaderData?.organization,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
    refetchOnMount: false,
  });

  const [organizationName, setOrganizationName] = useState(() => organization.name);

  const updateOrganization = useMutation(
    trpc.organization.updateName.mutationOptions({
      onSuccess: () => {
        goTo("2");
      },
      onError: (mutationError) => {
        toast.error(mutationError.message);
      },
    }),
  );

  return (
    <form
      className="space-y-8"
      onSubmit={async (event) => {
        event.preventDefault();
        const trimmedName = organizationName.trim();
        if (!trimmedName) {
          toast.error("Organization name is required");
          return;
        }
        await updateOrganization.mutateAsync({ organizationId, name: trimmedName });
      }}
    >
      <div className="space-y-3">
        <p className="text-muted-foreground">Step 1 of 3</p>
        <h2 className="text-2xl font-semibold">What is your organization called?</h2>
      </div>

      <div className="grid gap-8 md:grid-cols-2">
        <div className="text-muted-foreground">
          <p>
            If you're just playing around or planning to use @iterate alone, just leave this as is.
          </p>
        </div>

        <div className="space-y-4">
          <Input
            value={organizationName}
            onChange={(event) => {
              setOrganizationName(event.target.value);
            }}
            disabled={updateOrganization.isPending}
            autoFocus
            onFocus={(event) => {
              event.currentTarget.select();
            }}
          />
        </div>
      </div>
      <div className="flex justify-end pt-4">
        <Button type="submit" disabled={updateOrganization.isPending}>
          {updateOrganization.isPending ? (
            <>
              Confirming
              <ArrowRight className="ml-2 h-4 w-4" />
            </>
          ) : (
            <>
              Confirm
              <ArrowRight className="ml-2 h-4 w-4" />
            </>
          )}
        </Button>
      </div>
    </form>
  );
}

function ConnectGithubAppStep({ estateId, organizationId, goBack }: StepProps) {
  const trpc = useTRPC();

  const startGithubInstall = useMutation(
    trpc.integrations.startGithubAppInstallFlow.mutationOptions({
      onError: (mutationError) => {
        toast.error(mutationError.message);
      },
    }),
  );

  const handleStartGithubInstall = async () => {
    const callbackURL = `/${organizationId}/onboarding/4`;
    const { installationUrl } = await startGithubInstall.mutateAsync({
      estateId,
      callbackURL,
    });
    window.location.href = installationUrl.toString();
  };

  return (
    <div className="space-y-8">
      <div className="space-y-3">
        <p className="text-muted-foreground">Step 3 of 3</p>
        <h2 className="text-2xl font-semibold">Give us access to the git repo</h2>
      </div>

      <div className="grid gap-8 md:grid-cols-2">
        <div className="space-y-4 text-muted-foreground">
          <p>On the next page, select the organization you created the repo in.</p>
          <p>Then select "Only select repositories" and choose the iterate repo you created.</p>
        </div>
        <div />
      </div>

      <div className="flex justify-between items-center pt-4">
        <Button variant="ghost" onClick={goBack}>
          <ArrowLeft className="mr-2 h-4 w-4" />
          Back
        </Button>
        <Button
          onClick={handleStartGithubInstall}
          disabled={startGithubInstall.isPending}
          autoFocus
        >
          {startGithubInstall.isPending ? (
            <>
              Redirecting to GitHub
              <ArrowRight className="ml-2 h-4 w-4" />
            </>
          ) : (
            <>
              Give @iterate access to repo
              <ArrowRight className="ml-2 h-4 w-4" />
            </>
          )}
        </Button>
      </div>
    </div>
  );
}

function SelectRepositoryStep({ estateId, goTo, goBack }: StepProps) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  const githubRepoQuery = trpc.integrations.getGithubRepoForEstate.queryOptions({ estateId });
  const { data: githubRepo } = useSuspenseQuery({
    ...githubRepoQuery,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
    refetchOnMount: false,
  });
  const availableReposQuery = trpc.integrations.listAvailableGithubRepos.queryOptions({ estateId });
  const { data: availableRepos } = useSuspenseQuery({
    ...availableReposQuery,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
    refetchOnMount: false,
  });

  const [selectedRepoId, setSelectedRepoId] = useState(() => {
    if (githubRepo?.repoId) return githubRepo.repoId.toString();
    if (availableRepos && availableRepos.length === 1) return availableRepos[0].id.toString();
    return "";
  });
  const [repoBranch, setRepoBranch] = useState(() => githubRepo?.branch ?? "main");
  const [repoPath, setRepoPath] = useState(() => githubRepo?.path ?? "/");
  const [isAdvancedOpen, setIsAdvancedOpen] = useState(false);

  const repoOptions = useMemo(() => availableRepos ?? [], [availableRepos]);

  const setGithubRepo = useMutation(
    trpc.integrations.setGithubRepoForEstate.mutationOptions({
      onSuccess: (_data, variables) => {
        toast.success("GitHub repository connected");
        setSelectedRepoId(String(variables.repoId));
        setRepoBranch(variables.branch ?? "main");
        setRepoPath(variables.path ?? "/");
        queryClient.invalidateQueries({
          queryKey: trpc.integrations.getGithubRepoForEstate.queryKey({ estateId }),
        });
        queryClient.invalidateQueries({
          queryKey: trpc.integrations.listAvailableGithubRepos.queryKey({ estateId }),
        });
        // Go to next step
        goTo("5");
      },
      onError: (mutationError) => {
        toast.error(mutationError.message);
      },
    }),
  );
  const disconnectGithubRepo = useMutation(
    trpc.integrations.disconnectGithubRepo.mutationOptions({
      onSuccess: () => {
        toast.success("GitHub connection removed");
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
        toast.error(mutationError.message);
      },
    }),
  );

  const saveGithubConfiguration = async () => {
    if (!selectedRepoId) {
      toast.error("Select a repository to continue");
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

  return (
    <div className="space-y-8">
      <div className="space-y-3">
        <p className="text-muted-foreground">Step 3 of 3</p>
        <h2 className="text-2xl font-semibold">Give us access to the git repo</h2>
      </div>

      {isConnected ? (
        <div className="grid gap-8 md:grid-cols-2">
          <div className="space-y-3 text-muted-foreground">
            <div className="flex items-center gap-2">
              <CheckCircle className="h-5 w-5 text-green-600" />
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
          <div />
        </div>
      ) : (
        <div className="grid gap-8 md:grid-cols-2">
          <div className="text-muted-foreground">
            <p>Select the iterate repository you created from the dropdown on the right.</p>
          </div>

          <div className="space-y-4">
            <form className="space-y-4" onSubmit={handleSaveConfigurationSubmit}>
              <div className="space-y-2">
                <Select value={selectedRepoId} onValueChange={setSelectedRepoId}>
                  <SelectTrigger className="w-full">
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
                    className="flex items-center gap-2 p-0 h-auto font-normal text-sm text-muted-foreground hover:text-foreground ml-auto"
                  >
                    Advanced settings
                    <ChevronDown
                      className={`h-4 w-4 transition-transform ${isAdvancedOpen ? "rotate-180" : ""}`}
                    />
                  </Button>
                </CollapsibleTrigger>
                <CollapsibleContent className="space-y-4 mt-4">
                  <p className="text-sm text-muted-foreground">
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
                </CollapsibleContent>
              </Collapsible>

              {/* Hidden submit to allow Enter from inputs/selects to submit */}
              <button type="submit" className="hidden" aria-hidden />
            </form>
          </div>
        </div>
      )}

      <div className="flex justify-between items-center pt-4">
        {isConnected ? (
          <>
            <div className="flex gap-2">
              <Button variant="ghost" onClick={goBack}>
                <ArrowLeft className="mr-2 h-4 w-4" />
                Back
              </Button>
              <Button
                variant="outline"
                onClick={handleDisconnect}
                disabled={disconnectGithubRepo.isPending}
              >
                {disconnectGithubRepo.isPending ? <Spinner className="mr-2" /> : null}
                Disconnect
              </Button>
            </div>
            <Button onClick={() => goTo("5")} autoFocus>
              Next: Connect Slack
              <ArrowRight className="ml-2 h-4 w-4" />
            </Button>
          </>
        ) : (
          <>
            <Button variant="ghost" onClick={goBack}>
              <ArrowLeft className="mr-2 h-4 w-4" />
              Back
            </Button>
            <Button
              onClick={() => void saveGithubConfiguration()}
              disabled={setGithubRepo.isPending || !selectedRepoId}
              autoFocus
            >
              {setGithubRepo.isPending ? (
                <>
                  Connecting repository
                  <ArrowRight className="ml-2 h-4 w-4" />
                </>
              ) : (
                <>
                  Connect repository
                  <ArrowRight className="ml-2 h-4 w-4" />
                </>
              )}
            </Button>
          </>
        )}
      </div>
    </div>
  );
}

function SlackStep({ organizationId }: StepProps) {
  const handleOpenSlack = () => {
    window.open("slack://open", "_blank", "noopener,noreferrer");
  };

  return (
    <div className="flex justify-center">
      <Card variant="muted" className="w-full max-w-2xl">
        <CardContent className="px-12 py-16">
          <div className="text-center space-y-8">
            <h2 className="text-4xl font-semibold">You're all set!</h2>
            <Button
              size="lg"
              className="h-auto w-full max-w-md px-12 py-6 text-xl"
              onClick={handleOpenSlack}
            >
              <img src="/slack.svg" alt="Slack" className="h-6 w-6 mr-3" />
              Continue in Slack
            </Button>
            <div>
              <Button
                variant="ghost"
                className="text-sm text-muted-foreground hover:text-foreground"
                asChild
              >
                <a href={`/${organizationId}`}>Or go to your dashboard</a>
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

export default function OrganizationOnboarding() {
  const params = useParams<{ organizationId: string; step?: string }>();
  const { organizationId, step: routeStep } = params;
  const { estateId } = useLoaderData<typeof loader>();
  const navigate = useNavigate();

  const allowedSteps = ["1", "2", "3", "4", "5"] as const;
  type StepKey = (typeof allowedSteps)[number];
  const isStepKey = (s: string | null): s is StepKey =>
    s !== null && (allowedSteps as readonly string[]).includes(s);
  const currentStep: StepKey = isStepKey(routeStep ?? null) ? (routeStep as StepKey) : "1";

  const navigateToStep = (step: string) => {
    navigate(`/${organizationId}/onboarding/${step}`);
  };

  if (!organizationId) {
    return null;
  }

  const steps = {
    "1": OrganizationNameStep,
    "2": SetupIterateRepoStep,
    "3": ConnectGithubAppStep,
    "4": SelectRepositoryStep,
    "5": SlackStep,
  } as const;

  const ActiveStep = steps[currentStep] ?? OrganizationNameStep;

  return (
    <>
      <main className="min-h-screen w-full flex justify-center p-8">
        <div className="w-full max-w-4xl py-16">
          <ActiveStep
            organizationId={organizationId}
            estateId={estateId}
            goTo={(s: string) => navigateToStep(s)}
            goBack={() => {
              const prev = String(Math.max(1, Number(currentStep) - 1));
              navigateToStep(prev);
            }}
          />
        </div>
      </main>
    </>
  );
}
