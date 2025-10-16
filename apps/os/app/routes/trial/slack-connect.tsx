import { useState, useEffect } from "react";
import { useMutation, useSuspenseQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router";
import { toast } from "sonner";
import { Mail, AlertCircle, Rocket, ArrowRight } from "lucide-react";
import { Button } from "../../components/ui/button.tsx";
import { Input } from "../../components/ui/input.tsx";
import { Alert, AlertDescription, AlertTitle } from "../../components/ui/alert.tsx";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldSet,
} from "../../components/ui/field.tsx";
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
    "confirm-email" | "alternate-email" | "processing" | "success" | "already-configured"
  >("confirm-email");
  const [alternateEmail, setAlternateEmail] = useState("");
  const [trialData, setTrialData] = useState<{
    estateId: string;
    organizationId: string;
    channelName: string;
    channelId: string;
  } | null>(null);

  // Check if user already has a trial estate set up
  const existingTrialEstate = userEstates.find((estate) => estate.slackTrialConnectChannelId);

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
        <div className="w-full max-w-md space-y-6 text-center">
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
    ...trpc.trial.setupSlackConnectTrial.mutationOptions({}),
    onSuccess: (data) => {
      if (!data.success) {
        if ("error" in data && data.error === "invalid_email") {
          toast.error("message" in data ? data.message : "Email not found in Slack");
          setStep("alternate-email");
        }
      } else {
        setTrialData({
          estateId: data.estateId,
          organizationId: data.organizationId,
          channelName: "channelName" in data ? data.channelName : "",
          channelId: "channelId" in data ? data.channelId : "",
        });
        setStep("success");
      }
    },
    onError: (error) => {
      toast.error(`Failed to set up trial: ${error.message}`);
      setStep("confirm-email");
    },
  });

  // Retry with alternate email mutation
  const retryMutation = useMutation({
    ...trpc.trial.retrySlackConnectInvite.mutationOptions({}),
    onSuccess: (data) => {
      if (data.success && trialData) {
        setStep("success");
        toast.success("Invite sent successfully!");
      }
    },
    onError: (error) => {
      toast.error(`Failed to send invite: ${error.message}`);
    },
  });

  const handleContinueWithEmail = () => {
    setStep("processing");
    setupTrialMutation.mutate({
      userEmail: user.email,
      userName: user.name,
    });
  };

  const handleRetryWithAlternateEmail = () => {
    if (!alternateEmail || !trialData) {
      toast.error("Please enter a valid email address");
      return;
    }

    retryMutation.mutate({
      estateId: trialData.estateId,
      alternateEmail,
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
        <div className="w-full max-w-md space-y-6 text-center">
          <div className="space-y-2">
            <h1 className="text-3xl font-bold">You're Already Set Up!</h1>
            <p className="text-muted-foreground">
              Your account is already associated with a workspace
            </p>
          </div>

          <Alert>
            <AlertDescription>
              <div className="space-y-2 text-left">
                <div>
                  <span className="font-medium">Estate:</span> {existingFullEstate.name}
                </div>
                <div>
                  <span className="font-medium">Organization:</span>{" "}
                  {existingFullEstate.organization?.name}
                </div>
              </div>
            </AlertDescription>
          </Alert>

          <Button onClick={handleGoToDashboard} size="lg" className="w-full">
            Go to Dashboard
            <ArrowRight className="ml-2 h-4 w-4" />
          </Button>
        </div>
      </div>
    );
  }

  if (step === "processing") {
    return (
      <div className="flex min-h-screen items-center justify-center p-4">
        <div className="w-full max-w-md space-y-6 text-center">
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
        <div className="w-full max-w-md space-y-6 text-center">
          <div className="flex justify-center">
            <div className="p-4 rounded-full bg-green-100 dark:bg-green-900/20">
              <Rocket className="h-12 w-12 text-green-600 dark:text-green-400" />
            </div>
          </div>

          <div className="space-y-2">
            <h1 className="text-3xl font-bold">You're all set!</h1>
            <p className="text-muted-foreground">Check your email for a Slack Connect invitation</p>
          </div>

          <div className="space-y-4">
            <Alert>
              <Mail className="h-4 w-4" />
              <AlertTitle>What's next?</AlertTitle>
              <AlertDescription>
                <ol className="list-decimal list-inside space-y-2 mt-2">
                  <li>Check your email for a Slack invite</li>
                  <li>
                    Accept the invite to join the shared channel:{" "}
                    <code className="text-xs bg-muted px-1 py-0.5 rounded">
                      #{trialData?.channelName}
                    </code>
                  </li>
                  <li>Start chatting with your iterate agent!</li>
                </ol>
              </AlertDescription>
            </Alert>

            <Button onClick={handleGoToDashboard} className="w-full" size="lg">
              Go to Dashboard
              <ArrowRight className="ml-2 h-4 w-4" />
            </Button>
            <p className="text-xs text-muted-foreground">
              You can manage your estate and agents from the dashboard
            </p>
          </div>
        </div>
      </div>
    );
  }

  if (step === "alternate-email") {
    return (
      <div className="flex min-h-screen items-center justify-center p-4">
        <div className="w-full max-w-md space-y-6">
          <div className="space-y-2 text-center">
            <h1 className="text-2xl font-bold">Email Not Found in Slack</h1>
            <p className="text-muted-foreground">
              Your Google email isn't associated with a Slack account
            </p>
          </div>

          <div className="space-y-4">
            <form
              onSubmit={(e) => {
                e.preventDefault();
                handleRetryWithAlternateEmail();
              }}
              className="space-y-4"
            >
              <FieldGroup>
                <FieldSet>
                  <Field>
                    <FieldLabel htmlFor="alternate-email">Your Slack Email Address</FieldLabel>
                    <Input
                      id="alternate-email"
                      type="email"
                      placeholder="you@company.com"
                      value={alternateEmail}
                      onChange={(e) => setAlternateEmail(e.target.value)}
                      required
                    />
                    <FieldDescription>
                      Enter the email address associated with your Slack account
                    </FieldDescription>
                  </Field>
                </FieldSet>
              </FieldGroup>

              <div className="flex gap-2">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setStep("confirm-email")}
                  className="flex-1"
                >
                  Back
                </Button>
                <Button type="submit" disabled={retryMutation.isPending} className="flex-1">
                  {retryMutation.isPending ? "Sending..." : "Send Invite"}
                </Button>
              </div>
            </form>
          </div>
        </div>
      </div>
    );
  }

  // Default: confirm-email step
  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <div className="w-full max-w-md space-y-6">
        <div className="space-y-2 text-center">
          <h1 className="text-2xl font-bold">Confirm Your Email</h1>
          <p className="text-muted-foreground">
            We'll send a Slack Connect invitation to this email
          </p>
        </div>

        <div className="space-y-4">
          <Alert>
            <Mail className="h-4 w-4" />
            <AlertDescription>
              <div className="space-y-1">
                <div>
                  <span className="font-medium">Signed in as:</span>
                </div>
                <div className="text-sm">
                  {user.name} ({user.email})
                </div>
              </div>
            </AlertDescription>
          </Alert>

          <Alert>
            <AlertCircle className="h-4 w-4" />
            <AlertTitle>How This Works</AlertTitle>
            <AlertDescription>
              <ol className="list-decimal list-inside space-y-1 mt-2 text-sm">
                <li>We'll create a private Slack Connect channel</li>
                <li>You'll receive an email invitation to join</li>
                <li>Accept the invite and start using iterate!</li>
              </ol>
            </AlertDescription>
          </Alert>

          <div className="space-y-2">
            <Button
              onClick={handleContinueWithEmail}
              disabled={setupTrialMutation.isPending}
              className="w-full"
              size="lg"
            >
              {setupTrialMutation.isPending ? (
                <>
                  <Spinner className="mr-2 h-4 w-4" />
                  Setting up...
                </>
              ) : (
                <>
                  Continue with {user.email}
                  <ArrowRight className="ml-2 h-4 w-4" />
                </>
              )}
            </Button>

            <button
              type="button"
              onClick={() => setStep("alternate-email")}
              className="w-full text-sm text-muted-foreground hover:text-foreground underline"
            >
              Use a different email address
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
