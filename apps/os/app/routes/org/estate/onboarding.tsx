import { useState } from "react";
import { redirect, useLoaderData } from "react-router";
import { ArrowRight } from "lucide-react";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { eq } from "drizzle-orm";
import { getDb } from "../../../../backend/db/client.ts";
import { getPendingUserSteps } from "../../../../backend/onboarding-user-steps.ts";
import * as schema from "../../../../backend/db/schema.ts";
import { Button } from "../../../components/ui/button.tsx";
import { Input } from "../../../components/ui/input.tsx";
import { Card, CardContent } from "../../../components/ui/card.tsx";
import { useTRPC } from "../../../lib/trpc.ts";
import { authClient } from "../../../lib/auth-client.ts";
import type { Route } from "./+types/onboarding.ts";

export async function loader({ params, request }: Route.LoaderArgs) {
  const { estateId, organizationId } = params;

  if (!estateId || !organizationId) {
    throw redirect("/");
  }

  const db = getDb();

  // Note: The parent estate loader already checks session and estate access
  // so we know the user is authenticated and has access to this estate

  // Get pending user steps
  const pendingSteps = await getPendingUserSteps(db, estateId);

  // If no pending steps, redirect to dashboard
  if (pendingSteps.length === 0) {
    throw redirect(`/${organizationId}/${estateId}`);
  }

  // Get organization for display
  const organization = await db.query.organization.findFirst({
    where: eq(schema.organization.id, organizationId),
  });

  if (!organization) {
    throw new Error("Organization not found");
  }

  return {
    pendingSteps,
    organization,
    estateId,
    organizationId,
  };
}

function ConfirmOrgNameStep({
  organizationId,
  estateId,
  organizationName,
  onComplete,
}: {
  organizationId: string;
  estateId: string;
  organizationName: string;
  onComplete: () => void;
}) {
  const trpc = useTRPC();
  const [name, setName] = useState(organizationName);

  const updateOrg = useMutation(
    trpc.organization.updateName.mutationOptions({
      onSuccess: () => {
        toast.success("Organization name updated");
        onComplete();
      },
      onError: (error) => {
        toast.error(error.message);
      },
    }),
  );

  const completeStep = useMutation(
    trpc.estate.completeUserOnboardingStep.mutationOptions({
      onSuccess: onComplete,
      onError: (error) => {
        toast.error(error.message);
      },
    }),
  );

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <h2 className="text-2xl font-semibold">Confirm your organization name</h2>
        <p className="text-muted-foreground">
          This will be shown to your team members. You can change it later in settings.
        </p>
      </div>

      <form
        className="space-y-4"
        onSubmit={async (e) => {
          e.preventDefault();
          if (name.trim() !== organizationName) {
            await updateOrg.mutateAsync({ organizationId, name: name.trim() });
          } else {
            await completeStep.mutateAsync({
              estateId,
              step: "confirm_org_name",
            });
          }
        }}
      >
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          disabled={updateOrg.isPending || completeStep.isPending}
          placeholder="Your Organization Name"
          autoFocus
        />

        <div className="flex justify-end">
          <Button
            type="submit"
            disabled={updateOrg.isPending || completeStep.isPending || !name.trim()}
          >
            Continue
            <ArrowRight className="ml-2 h-4 w-4" />
          </Button>
        </div>
      </form>
    </div>
  );
}

function ConnectSlackStep({ estateId }: { estateId: string; onComplete: () => void }) {
  const [isConnecting, setIsConnecting] = useState(false);

  const handleConnect = async () => {
    setIsConnecting(true);
    try {
      const result = await authClient.integrations.link.slackBot({
        estateId,
        callbackURL: window.location.href,
      });
      window.location.href = result.url.toString();
    } catch (error) {
      toast.error("Failed to start Slack connection");
      setIsConnecting(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <h2 className="text-2xl font-semibold">Connect to Slack</h2>
        <p className="text-muted-foreground">
          Connect your Slack workspace to start using iterate with your team.
        </p>
      </div>

      <Button size="lg" onClick={handleConnect} disabled={isConnecting} className="w-full max-w-md">
        <img src="/slack.svg" alt="Slack" className="mr-2 h-5 w-5" />
        {isConnecting ? "Connecting..." : "Connect Slack"}
      </Button>
    </div>
  );
}

function ConnectGitHubStep({ estateId }: { estateId: string; onComplete: () => void }) {
  const trpc = useTRPC();
  const [isConnecting, setIsConnecting] = useState(false);

  const linkGitHub = useMutation(
    trpc.integrations.startGithubAppInstallFlow.mutationOptions({
      onSuccess: (data) => {
        window.location.href = data.installationUrl;
      },
      onError: (error) => {
        toast.error(error.message);
        setIsConnecting(false);
      },
    }),
  );

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <h2 className="text-2xl font-semibold">Connect to GitHub</h2>
        <p className="text-muted-foreground">
          Connect your GitHub account so iterate can access your repositories.
        </p>
      </div>

      <Button
        size="lg"
        onClick={() => {
          setIsConnecting(true);
          linkGitHub.mutate({
            estateId,
            callbackURL: window.location.href,
          });
        }}
        disabled={isConnecting || linkGitHub.isPending}
        className="w-full max-w-md"
      >
        {isConnecting || linkGitHub.isPending ? "Connecting..." : "Connect GitHub"}
      </Button>
    </div>
  );
}

function SetupRepoStep({ estateId, onComplete }: { estateId: string; onComplete: () => void }) {
  // This will need to be implemented - for now just show a placeholder
  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <h2 className="text-2xl font-semibold">Connect your repository</h2>
        <p className="text-muted-foreground">
          Connect a GitHub repository for iterate to work with.
        </p>
      </div>

      <div className="space-y-4">
        <p className="text-sm text-muted-foreground">
          Repository connection UI will be implemented here.
        </p>
        <Button onClick={onComplete}>Skip for now</Button>
      </div>
    </div>
  );
}

export default function EstateOnboarding() {
  const { pendingSteps, organization, estateId, organizationId } = useLoaderData<typeof loader>();

  const handleStepComplete = () => {
    // Reload the page to get updated pending steps
    window.location.reload();
  };

  // Show first pending step
  const firstPendingStep = pendingSteps[0];

  if (!firstPendingStep) {
    // No more pending steps, redirect
    window.location.href = `/${organizationId}/${estateId}`;
    return null;
  }

  let stepComponent;
  switch (firstPendingStep.eventType) {
    case "confirm_org_name":
      stepComponent = (
        <ConfirmOrgNameStep
          organizationId={organizationId}
          estateId={estateId}
          organizationName={organization.name}
          onComplete={handleStepComplete}
        />
      );
      break;
    case "connect_slack":
      stepComponent = <ConnectSlackStep estateId={estateId} onComplete={handleStepComplete} />;
      break;
    case "connect_github":
      stepComponent = <ConnectGitHubStep estateId={estateId} onComplete={handleStepComplete} />;
      break;
    case "setup_repo":
      stepComponent = <SetupRepoStep estateId={estateId} onComplete={handleStepComplete} />;
      break;
    default:
      stepComponent = <div>Unknown step: {firstPendingStep.eventType}</div>;
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-4 md:p-8">
      <Card className="w-full max-w-2xl">
        <CardContent className="p-8 md:p-12">
          <div className="mb-8">
            <p className="text-sm text-muted-foreground mb-2">
              Step {pendingSteps.length > 0 ? 5 - pendingSteps.length : 0} of 4
            </p>
            <h1 className="text-3xl font-semibold">Complete your setup</h1>
          </div>

          {stepComponent}
        </CardContent>
      </Card>
    </div>
  );
}
