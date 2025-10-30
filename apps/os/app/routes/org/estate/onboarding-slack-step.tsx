import { useState } from "react";
import { useMutation, useSuspenseQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router";
import { Check } from "lucide-react";
import { toast } from "sonner";
import { authClient } from "../../../lib/auth-client.ts";
import { useTRPC } from "../../../lib/trpc.ts";
import { Button } from "../../../components/ui/button.tsx";
import { Card, CardContent } from "../../../components/ui/card.tsx";
import { Spinner } from "../../../components/ui/spinner.tsx";
import { OnboardingStepLayout } from "./onboarding-step-layout.tsx";

type SlackStepView = "choose-method" | "confirm-email" | "processing-trial" | "trial-success";

type SlackStepProps = {
  organizationId: string;
  estateId: string;
  /**
   * Called when the Slack step has successfully completed (e.g. trial channel created).
   * Parent can use this to mark onboarding as completed on the backend.
   */
  onComplete: () => void;
};

export function OnboardingSlackStep({ organizationId, estateId, onComplete }: SlackStepProps) {
  const navigate = useNavigate();
  const trpc = useTRPC();
  const [view, setView] = useState<SlackStepView>("choose-method");
  const [trialData, setTrialData] = useState<{
    estateId: string;
    organizationId: string;
    channelName: string;
    channelId: string;
  } | null>(null);

  const { data: user } = useSuspenseQuery(trpc.user.me.queryOptions());

  const directSlackLogin = async () => {
    const result = await authClient.integrations.link.slackBot({
      callbackURL: `/${organizationId}/${estateId}/onboarding?step=slack_complete`,
      estateId: estateId,
    });

    if (!result || !("url" in result)) {
      toast.error("Failed to initiate Slack authentication");
      return;
    }

    window.location.href = result.url.toString();
  };

  const setupTrialMutation = useMutation({
    ...trpc.integrations.setupSlackConnectTrial.mutationOptions({}),
    onSuccess: (data) => {
      setTrialData({
        estateId: data.estateId,
        organizationId: data.organizationId,
        channelName: "channelName" in data ? data.channelName : "",
        channelId: "channelId" in data ? data.channelId : "",
      });
      setView("trial-success");
      // Notify parent that Slack onboarding is complete so it can mark overall onboarding complete
      onComplete();
    },
    onError: (error) => {
      if (String(error).includes("name_taken")) {
        onComplete();
        return;
      }
      toast.error(`Failed to set up trial: ${error.message}`);
      setView("choose-method");
    },
  });

  const handleSlackConnectFlow = () => {
    setView("confirm-email");
  };

  const handleContinueWithEmail = () => {
    setView("processing-trial");
    setupTrialMutation.mutate();
  };

  const handleGoToDashboard = () => {
    if (trialData) {
      navigate(`/${trialData.organizationId}/${trialData.estateId}`);
    } else {
      navigate(`/${organizationId}/${estateId}`);
    }
  };

  const handleOpenSlack = () => {
    window.open("slack://open", "_blank", "noopener,noreferrer");
  };

  if (view === "processing-trial") {
    return (
      <div className="flex justify-center">
        <div className="w-full max-w-2xl space-y-6 text-center py-16">
          <Spinner className="h-12 w-12 mx-auto" />
          <div>
            <h2 className="text-2xl font-semibold">Setting up your trial...</h2>
            <p className="text-muted-foreground mt-2">Creating your Slack Connect channel</p>
          </div>
        </div>
      </div>
    );
  }

  if (view === "trial-success") {
    return (
      <div className="flex justify-center">
        <Card variant="muted" className="w-full max-w-2xl">
          <CardContent className="px-12 py-16">
            <div className="text-center space-y-8">
              <h2 className="text-4xl font-semibold">You're all set!</h2>

              <div className="space-y-4 text-sm text-muted-foreground">
                <div className="space-y-2">
                  <p className="font-medium text-foreground">What's next?</p>
                  <ol className="list-decimal list-inside space-y-1.5 text-left max-w-md mx-auto">
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

              <div className="flex flex-col gap-2">
                <Button
                  size="lg"
                  className="h-auto w-full max-w-md px-12 py-6 text-xl mx-auto"
                  onClick={handleOpenSlack}
                >
                  <img src="/slack.svg" alt="Slack" className="h-6 w-6 mr-3" />
                  Open in Slack
                </Button>
                <Button
                  variant="ghost"
                  className="text-sm text-muted-foreground hover:text-foreground"
                  onClick={handleGoToDashboard}
                >
                  Or go to your dashboard
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (view === "confirm-email") {
    return (
      <OnboardingStepLayout
        stepText="Step 2 of 2"
        title="Confirm your email"
        description="We'll send a Slack Connect invitation to this email"
        maxWidthClass="max-w-md"
      >
        <div className="space-y-4">
          <div className="text-center p-4 bg-muted/50 rounded-lg">
            <div className="text-sm font-medium">{user.name}</div>
            <div className="text-sm text-muted-foreground">{user.email}</div>
          </div>

          <div className="flex gap-2">
            <Button variant="outline" onClick={() => setView("choose-method")} className="flex-1">
              Back
            </Button>
            <Button
              onClick={handleContinueWithEmail}
              disabled={setupTrialMutation.isPending}
              className="flex-1"
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
      </OnboardingStepLayout>
    );
  }

  // Default: choose-method view
  return (
    <OnboardingStepLayout
      stepText="Step 2 of 2"
      title="Connect Slack"
      description="Choose how you want to connect iterate to Slack. If you're not a workspace admin, use Slack Connect."
    >
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 md:gap-6">
        {/* Option 1: Slack Connect (Default/Recommended) */}
        <Card className="hover:border-primary transition-colors group flex flex-col shadow-none border-2 border-primary/50">
          <CardContent className="flex flex-col flex-1 px-6 py-6 md:px-10 md:py-8">
            <div className="flex flex-col flex-1">
              <h3 className="text-lg md:text-xl font-semibold mb-4 md:mb-6">
                Try{" "}
                <span className="px-1.5 py-0.5 rounded bg-primary/10 text-primary">@iterate</span>{" "}
                with Slack Connect
              </h3>

              <ul className="space-y-2.5 md:space-y-3 text-sm text-muted-foreground mb-4 md:mb-6 flex-1 pl-2">
                <li className="flex items-start gap-3">
                  <div className="rounded-full bg-green-600 p-0.5 mt-0.5 shrink-0">
                    <Check className="h-3 w-3 text-white" strokeWidth={3} />
                  </div>
                  <span>No Slack workspace admin permissions required</span>
                </li>
                <li className="flex items-start gap-3">
                  <div className="rounded-full bg-green-600 p-0.5 mt-0.5 shrink-0">
                    <Check className="h-3 w-3 text-white" strokeWidth={3} />
                  </div>
                  <span>Start using iterate in minutes</span>
                </li>
                <li className="flex items-start gap-3">
                  <div className="rounded-full bg-yellow-600 p-0.5 mt-0.5 shrink-0 flex items-center justify-center w-4 h-4">
                    <span className="text-white text-xs font-bold leading-none">!</span>
                  </div>
                  <span>Limited to one shared channel</span>
                </li>
              </ul>

              <Button
                onClick={handleSlackConnectFlow}
                className="w-full h-14 border-2 border-primary bg-primary hover:bg-primary/90"
              >
                <img src="/slack.svg" alt="Slack" className="mr-2 h-5 w-5" />
                Continue with Slack Connect
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* Option 2: Full Slack Bot (Requires Admin) */}
        <Card
          variant="muted"
          className="hover:border-primary transition-colors group flex flex-col shadow-none"
        >
          <CardContent className="flex flex-col flex-1 px-6 py-6 md:px-8 md:py-8">
            <div className="flex flex-col flex-1">
              <h3 className="text-lg md:text-xl font-semibold mb-4 md:mb-6">
                Add{" "}
                <span className="px-1.5 py-0.5 rounded bg-primary/10 text-primary">@iterate</span>{" "}
                to your workspace
              </h3>

              <ul className="space-y-2.5 md:space-y-3 text-sm text-muted-foreground mb-4 md:mb-6 flex-1 pl-2">
                <li className="flex items-start gap-3">
                  <div className="rounded-full bg-green-600 p-0.5 mt-0.5 shrink-0">
                    <Check className="h-3 w-3 text-white" strokeWidth={3} />
                  </div>
                  <span>Use @iterate in all your Slack channels</span>
                </li>
                <li className="flex items-start gap-3">
                  <div className="rounded-full bg-green-600 p-0.5 mt-0.5 shrink-0">
                    <Check className="h-3 w-3 text-white" strokeWidth={3} />
                  </div>
                  <span>Everyone in your workspace can use it</span>
                </li>
                <li className="flex items-start gap-3">
                  <div className="rounded-full bg-yellow-600 p-0.5 mt-0.5 shrink-0 flex items-center justify-center w-4 h-4">
                    <span className="text-white text-xs font-bold leading-none">!</span>
                  </div>
                  <span>Requires Slack workspace admin permissions</span>
                </li>
              </ul>

              <Button onClick={directSlackLogin} variant="outline" className="w-full h-14">
                <img src="/slack.svg" alt="Slack" className="mr-2 h-5 w-5" />
                Add to Slack Workspace
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    </OnboardingStepLayout>
  );
}
