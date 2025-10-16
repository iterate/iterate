import { useState } from "react";
import { useNavigate } from "react-router";
import { authClient } from "../lib/auth-client.ts";
import { Button } from "../components/ui/button.tsx";
import { Card, CardContent } from "../components/ui/card.tsx";
import { Alert, AlertDescription } from "../components/ui/alert.tsx";

type OnboardingView = "choose-option" | "auth-providers" | "no-slack";

export default function OnboardingPage() {
  const navigate = useNavigate();
  const [view, setView] = useState<OnboardingView>("choose-option");

  const handleSetupNow = () => {
    setView("auth-providers");
  };

  const handleGoogleAuth = async () => {
    await authClient.signIn.social({
      provider: "google",
      callbackURL: "/", // Will go through redirect logic to connect Slack
    });
  };

  const handleSlackAuth = async () => {
    const result = await authClient.integrations.directLoginWithSlack({
      query: {
        callbackURL: "/",
      },
    });

    if (!result || !("url" in result)) {
      return;
    }

    window.location.href = result.url.toString();
  };

  const handleSlackConnect = async () => {
    // First authenticate with Google, then redirect to trial flow
    await authClient.signIn.social({
      provider: "google",
      callbackURL: "/trial/slack-connect",
    });
  };

  const handleBack = () => {
    setView("choose-option");
  };

  if (view === "no-slack") {
    return (
      <div className="min-h-screen flex items-center justify-center p-4 bg-muted/20">
        <div className="w-full max-w-md space-y-6">
          <div className="space-y-2">
            <h1 className="text-2xl font-bold">Slack Required</h1>
            <p className="text-muted-foreground">
              iterate currently works exclusively through Slack as your interface to interact with
              AI agents.
            </p>
          </div>
          <Alert>
            <AlertDescription>
              We're focused on making the best Slack-based AI agent platform. If you're interested
              in other platforms, please let us know at{" "}
              <a href="mailto:hello@iterate.com" className="underline">
                hello@iterate.com
              </a>
            </AlertDescription>
          </Alert>
          <div className="flex justify-end gap-2 pt-4">
            <Button variant="outline" onClick={handleBack}>
              Back
            </Button>
            <Button onClick={() => navigate("/login")}>Got it</Button>
          </div>
        </div>
      </div>
    );
  }

  if (view === "auth-providers") {
    return (
      <div className="min-h-screen flex items-center justify-center p-4 bg-muted/20">
        <div className="w-full max-w-md space-y-6">
          <div className="space-y-2">
            <h1 className="text-3xl font-bold">Choose your sign-in method</h1>
            <p className="text-muted-foreground">Select how you'd like to authenticate</p>
          </div>

          <div className="space-y-4">
            <div className="space-y-3">
              <Button
                onClick={handleGoogleAuth}
                variant="outline"
                size="lg"
                className="w-full h-12 text-base font-medium"
              >
                <svg className="mr-2 h-5 w-5" viewBox="0 0 24 24" fill="currentColor">
                  <path
                    d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
                    fill="#4285F4"
                  />
                  <path
                    d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
                    fill="#34A853"
                  />
                  <path
                    d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
                    fill="#FBBC05"
                  />
                  <path
                    d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
                    fill="#EA4335"
                  />
                </svg>
                Continue with Google
              </Button>
              <p className="text-xs text-muted-foreground text-center">
                You can connect Slack to your workspace later
              </p>
            </div>

            <div className="relative">
              <div className="absolute inset-0 flex items-center">
                <span className="w-full border-t" />
              </div>
              <div className="relative flex justify-center text-xs uppercase">
                <span className="bg-background px-2 text-muted-foreground">Or</span>
              </div>
            </div>

            <div className="space-y-3">
              <Button
                onClick={handleSlackAuth}
                variant="outline"
                size="lg"
                className="w-full h-12 text-base font-medium"
              >
                <img src="/slack.svg" alt="Slack" className="mr-2 h-5 w-5" />
                Continue with Slack
              </Button>
              <p className="text-xs text-muted-foreground text-center">
                Bot will be immediately installed to your workspace
              </p>
            </div>
          </div>

          <div className="flex justify-center pt-2 border-t">
            <Button variant="ghost" size="sm" onClick={handleBack}>
              Back to options
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-4 bg-muted/20">
      <div className="w-full max-w-4xl space-y-6">
        <div className="space-y-2">
          <h1 className="text-4xl font-bold">
            How would you like to use{" "}
            <span className="inline-flex items-baseline rounded bg-[#1264a3]/10 dark:bg-[#1264a3]/20 px-1 py-0.5 text-[#1264a3] dark:text-[#1d9bd1] font-semibold">
              @iterate
            </span>
            ?
          </h1>
          <p className="text-muted-foreground text-lg">
            Choose the option that works best for your workspace
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6 py-6">
          {/* Option 1: Add to Slack Workspace */}
          <Card
            variant="muted"
            className="hover:border-primary transition-colors cursor-pointer group"
          >
            <CardContent className="pt-8 pb-6">
              <div className="space-y-4">
                <h3 className="text-xl font-semibold">Add to Your Slack Workspace</h3>

                <p className="text-sm text-muted-foreground">
                  Full access to your workspace and all integrations
                </p>

                <p className="text-xs text-muted-foreground">
                  Requires Slack workspace admin permissions
                </p>

                <Button onClick={handleSetupNow} className="w-full" size="lg">
                  Setup Now
                </Button>
              </div>
            </CardContent>
          </Card>

          {/* Option 2: Slack Connect */}
          <Card
            variant="muted"
            className="hover:border-primary transition-colors cursor-pointer group"
          >
            <CardContent className="pt-8 pb-6">
              <div className="space-y-4">
                <h3 className="text-xl font-semibold">Try with Slack Connect</h3>

                <p className="text-sm text-muted-foreground">
                  Quick trial through a shared channel
                </p>

                <p className="text-xs text-muted-foreground">No admin permissions required</p>

                <Button onClick={handleSlackConnect} variant="outline" className="w-full" size="lg">
                  Try Slack Connect
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Footer option */}
        <div className="flex justify-center pt-4 border-t">
          <Button variant="ghost" size="sm" onClick={() => setView("no-slack")}>
            I don't use Slack
          </Button>
        </div>
      </div>
    </div>
  );
}
