import { createFileRoute } from "@tanstack/react-router";
import { authClient } from "../lib/auth-client.ts";
import { Button } from "../components/ui/button.tsx";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../components/ui/card.tsx";

export const Route = createFileRoute("/login")({
  component: LoginPage,
});

function LoginPage() {
  const handleGoogleLogin = async () => {
    await authClient.signIn.social({
      provider: "google",
      callbackURL: "/",
    });
  };

  const handleSlackLogin = async () => {
    await authClient.signIn.social({
      provider: "slack",
      callbackURL: "/",
    });
  };

  return (
    <div className="flex min-h-screen items-center justify-center">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <CardTitle className="text-2xl">Welcome to OS2</CardTitle>
          <CardDescription>Sign in to continue</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Button onClick={handleGoogleLogin} className="w-full" variant="outline">
            Continue with Google
          </Button>
          <Button onClick={handleSlackLogin} className="w-full" variant="outline">
            Continue with Slack
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
