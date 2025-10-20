import { useState } from "react";
import { useNavigate } from "react-router";
import { Check, MailIcon } from "lucide-react";
import { authClient } from "../lib/auth-client.ts";
import { Button } from "../components/ui/button.tsx";
import { Card, CardContent } from "../components/ui/card.tsx";
import { Alert, AlertDescription } from "../components/ui/alert.tsx";

type OnboardingView = "choose-option" | "auth-providers" | "no-slack";

export default function OnboardingPage() {
  const navigate = useNavigate();
  const [view, setView] = useState<OnboardingView>("choose-option");

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

  const handleSlackConnectWithEmail = async () => {
    const email = prompt("Enter your email");
    if (!email) return;
    const _otpResult = await authClient.emailOtp.sendVerificationOtp({ email, type: "sign-in" });
    if (!_otpResult) return;

    const otp = prompt("Enter the OTP we sent to your email");
    if (!otp) return;

    const signinResult = await authClient.signIn.emailOtp({ email, otp });
    if (!signinResult) return;

    window.location.href = "/trial/slack-connect";
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
            <Button onClick={() => navigate("/signup")}>Back</Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex md:items-center justify-center p-3 md:p-4 bg-muted/20">
      <div className="w-full max-w-4xl space-y-4 md:space-y-6 pt-6 md:pt-0">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 md:gap-6">
          {/* Option 1: Add to Slack Workspace */}
          <Card className="hover:border-primary transition-colors cursor-pointer group flex flex-col shadow-none">
            <CardContent className="flex flex-col flex-1 px-6 py-6 md:px-10 md:py-8">
              <div className="flex flex-col flex-1">
                <h3 className="text-lg md:text-xl font-semibold mb-4 md:mb-6">
                  Add{" "}
                  <span className="px-1.5 py-0.5 rounded bg-primary/10 text-primary">@iterate</span>{" "}
                  to your workspace
                </h3>

                <ul className="space-y-2.5 md:space-y-3 text-sm text-muted-foreground mb-4 md:mb-6 flex-1 pl-2">
                  <li className="flex items-start gap-3">
                    <div className="rounded-full bg-green-600 p-0.5 mt-0.5 flex-shrink-0">
                      <Check className="h-3 w-3 text-white" strokeWidth={3} />
                    </div>
                    <span>Use @iterate in all your Slack channels</span>
                  </li>
                  <li className="flex items-start gap-3">
                    <div className="rounded-full bg-green-600 p-0.5 mt-0.5 flex-shrink-0">
                      <Check className="h-3 w-3 text-white" strokeWidth={3} />
                    </div>
                    <span>Everyone in your workspace can use it</span>
                  </li>
                  <li className="flex items-start gap-3">
                    <div className="rounded-full bg-yellow-600 p-0.5 mt-0.5 flex-shrink-0 flex items-center justify-center w-4 h-4">
                      <span className="text-white text-xs font-bold leading-none">!</span>
                    </div>
                    <span>Requires Slack workspace admin permissions</span>
                  </li>
                </ul>

                <Button
                  onClick={handleSlackAuth}
                  variant="outline"
                  className="w-full h-14 border-2 border-primary bg-background hover:bg-accent"
                >
                  <img src="/slack.svg" alt="Slack" className="mr-2 h-5 w-5" />
                  Continue with Slack
                </Button>
              </div>
            </CardContent>
          </Card>

          {/* OR Separator - Mobile only */}
          <div className="md:hidden relative">
            <div className="absolute inset-0 flex items-center">
              <span className="w-full border-t" />
            </div>
            <div className="relative flex justify-center text-xs uppercase">
              <span className="bg-muted/20 px-2 text-muted-foreground">Or</span>
            </div>
          </div>

          {/* Option 2: Slack Connect */}
          <Card
            variant="muted"
            className="hover:border-primary transition-colors cursor-pointer group flex flex-col opacity-70 shadow-none"
          >
            <CardContent className="flex flex-col flex-1 px-6 py-6 md:px-8 md:py-8">
              <div className="flex flex-col flex-1">
                <h3 className="text-lg md:text-xl font-semibold mb-4 md:mb-6">
                  Try{" "}
                  <span className="px-1.5 py-0.5 rounded bg-primary/10 text-primary">@iterate</span>{" "}
                  with Slack Connect
                </h3>

                <ul className="space-y-2.5 md:space-y-3 text-sm text-muted-foreground mb-4 md:mb-6 flex-1 pl-2">
                  <li className="flex items-start gap-3">
                    <div className="rounded-full bg-green-600 p-0.5 mt-0.5 flex-shrink-0">
                      <Check className="h-3 w-3 text-white" strokeWidth={3} />
                    </div>
                    <span>No Slack workspace admin permissions required</span>
                  </li>
                  <li className="flex items-start gap-3">
                    <div className="rounded-full bg-yellow-600 p-0.5 mt-0.5 flex-shrink-0 flex items-center justify-center w-4 h-4">
                      <span className="text-white text-xs font-bold leading-none">!</span>
                    </div>
                    <span>People you invite to the channel can use the bot</span>
                  </li>
                  <li className="flex items-start gap-3">
                    <div className="rounded-full bg-yellow-600 p-0.5 mt-0.5 flex-shrink-0 flex items-center justify-center w-4 h-4">
                      <span className="text-white text-xs font-bold leading-none">!</span>
                    </div>
                    <span>Limited to one channel</span>
                  </li>
                </ul>

                <Button onClick={handleSlackConnect} variant="outline" className="w-full h-14">
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

                {import.meta.env.VITE_ENABLE_EMAIL_OTP_SIGNIN && (
                  <Button
                    onClick={handleSlackConnectWithEmail}
                    variant="outline"
                    className="w-full h-14 mt-2"
                  >
                    <MailIcon className="mr-2 h-5 w-5" />
                    Continue with Email
                  </Button>
                )}
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Footer option */}
        <div className="flex justify-center pt-2 md:pt-4 border-t">
          <Button variant="ghost" size="sm" onClick={() => setView("no-slack")}>
            I don't use Slack
          </Button>
        </div>
      </div>
    </div>
  );
}
