import { useState, useEffect } from "react";
import { useMutation, useSuspenseQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router";
import { toast } from "sonner";
import { Button } from "../../components/ui/button.tsx";
import { Spinner } from "../../components/ui/spinner.tsx";
import { useTRPC } from "../../lib/trpc.ts";
import type { Route } from "./+types/slack-connect.ts";

export function meta(_args: Route.MetaArgs) {
  return [
    { title: "Try Slack Connect - Iterate" },
    { name: "description", content: "Get started with iterate via Slack Connect" },
  ];
}

export default function TrialSlackConnectPage() {
  const navigate = useNavigate();
  const trpc = useTRPC();
  const { data: user } = useSuspenseQuery(trpc.user.me.queryOptions());

  // Check if user already has estates with full Slack integration
  const { data: userEstates } = useSuspenseQuery(trpc.estate.listAllForUser.queryOptions());

  const [step, setStep] = useState<
    "confirm-email" | "processing" | "success" | "already-configured"
  >("confirm-email");
  const [trialData, setTrialData] = useState<{
    estateId: string;
    organizationId: string;
    channelName: string;
    channelId: string;
  } | null>(null);

  // Check if user already has a trial estate set up
  const existingTrialEstate = userEstates.find((estate) => estate.isTrialEstate);

  // Redirect to home page if trial is already set up
  useEffect(() => {
    if (existingTrialEstate) {
      navigate(`/${existingTrialEstate.organizationId}/${existingTrialEstate.id}`, {
        replace: true,
      });
    }
  }, [existingTrialEstate, navigate]);

  // For now, always allow trial signup
  // TODO: Check if estate has actual Slack integration via providerEstateMapping
  const existingFullEstate = null as (typeof userEstates)[0] | null;

  // Show loading state while redirecting to existing trial
  if (existingTrialEstate) {
    return (
      <div className="flex min-h-screen items-center justify-center p-4">
        <div className="w-full max-w-sm space-y-6 text-center">
          <Spinner className="h-12 w-12 mx-auto" />
          <div>
            <h2 className="text-2xl font-semibold">Redirecting to your trial...</h2>
          </div>
        </div>
      </div>
    );
  }

  // Setup trial mutation
  const setupTrialMutation = useMutation({
    ...trpc.integrations.setupSlackConnectTrial.mutationOptions({}),
    onSuccess: (data) => {
      setTrialData({
        estateId: data.estateId,
        organizationId: data.organizationId,
        channelName: "channelName" in data ? data.channelName : "",
        channelId: "channelId" in data ? data.channelId : "",
      });
      setStep("success");
    },
    onError: (error) => {
      toast.error(`Failed to set up trial: ${error.message}`);
      setStep("confirm-email");
    },
  });

  const handleContinueWithEmail = () => {
    setStep("processing");
    setupTrialMutation.mutate({
      userEmail: user.email,
      userName: user.name,
    });
  };

  const handleGoToDashboard = () => {
    if (trialData) {
      navigate(`/${trialData.organizationId}/${trialData.estateId}`);
    } else if (existingFullEstate) {
      navigate(`/${existingFullEstate.organizationId}/${existingFullEstate.id}`);
    } else {
      navigate("/");
    }
  };

  // Check if user already has a full estate (not trial)
  if (existingFullEstate) {
    return (
      <div className="flex min-h-screen items-center justify-center p-4">
        <div className="w-full max-w-sm space-y-6">
          <div className="space-y-2 text-center">
            <h1 className="text-3xl font-bold">You're already set up!</h1>
            <p className="text-muted-foreground">
              Your account is already associated with a workspace
            </p>
          </div>

          <div className="text-center p-4 bg-muted/50 rounded-lg space-y-1">
            <div className="text-sm">
              <span className="font-medium">Estate:</span> {existingFullEstate.name}
            </div>
            <div className="text-sm text-muted-foreground">
              {existingFullEstate.organization?.name}
            </div>
          </div>

          <Button onClick={handleGoToDashboard} className="w-full h-12">
            Go to Dashboard
          </Button>
        </div>
      </div>
    );
  }

  if (step === "processing") {
    return (
      <div className="flex min-h-screen items-center justify-center p-4">
        <div className="w-full max-w-sm space-y-6 text-center">
          <Spinner className="h-12 w-12 mx-auto" />
          <div>
            <h2 className="text-2xl font-semibold">Setting up your trial...</h2>
            <p className="text-muted-foreground mt-2">
              Creating your workspace and Slack Connect channel
            </p>
          </div>
        </div>
      </div>
    );
  }

  if (step === "success") {
    return (
      <div className="flex min-h-screen items-center justify-center p-4">
        <div className="w-full max-w-sm space-y-6">
          <div className="space-y-2 text-center">
            <h1 className="text-3xl font-bold">You're all set!</h1>
            <p className="text-muted-foreground">Check your email for a Slack Connect invitation</p>
          </div>

          <div className="space-y-4 text-sm text-muted-foreground">
            <div className="space-y-2">
              <p className="font-medium text-foreground">What's next?</p>
              <ol className="list-decimal list-inside space-y-1.5">
                <li>Check your email for a Slack invite</li>
                <li>
                  Accept the invite to join{" "}
                  <code className="text-xs bg-muted px-1 py-0.5 rounded">
                    #{trialData?.channelName}
                  </code>
                </li>
                <li>
                  Start chatting with{" "}
                  <span
                    className="px-1 py-0.5 rounded text-xs"
                    style={{ backgroundColor: "#4A154B1A", color: "#4A154B" }}
                  >
                    @iterate
                  </span>
                </li>
              </ol>
            </div>
          </div>

          <Button onClick={handleGoToDashboard} className="w-full h-12">
            Go to Dashboard
          </Button>
        </div>
      </div>
    );
  }

  // Default: confirm-email step
  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <div className="w-full max-w-sm space-y-6">
        <div className="space-y-2 text-center">
          <h1 className="text-3xl font-bold">Confirm your email</h1>
          <p className="text-muted-foreground">
            We'll send a Slack Connect invitation to this email
          </p>
        </div>

        <div className="space-y-4">
          <div className="text-center p-4 bg-muted/50 rounded-lg">
            <div className="text-sm font-medium">{user.name}</div>
            <div className="text-sm text-muted-foreground">{user.email}</div>
          </div>

          <Button
            onClick={handleContinueWithEmail}
            disabled={setupTrialMutation.isPending}
            className="w-full h-12"
          >
            {setupTrialMutation.isPending ? (
              <>
                <Spinner className="mr-2 h-4 w-4" />
                Setting up...
              </>
            ) : (
              <>Continue</>
            )}
          </Button>
        </div>
      </div>
    </div>
  );
}
