import { createFileRoute } from "@tanstack/react-router";
import { Button } from "../components/ui/button.tsx";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../components/ui/card.tsx";
import { signIn } from "../lib/auth-client.ts";

export const Route = createFileRoute("/login")({
  component: LoginPage,
});

function LoginPage() {
  const handleGoogleSignIn = async () => {
    await signIn.social({
      provider: "google",
      callbackURL: "/",
    });
  };

  const handleSlackSignIn = async () => {
    await signIn.social({
      provider: "slack",
      callbackURL: "/",
    });
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-background">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <CardTitle className="text-2xl">Welcome to OS2</CardTitle>
          <CardDescription>Sign in to continue</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Button onClick={handleGoogleSignIn} className="w-full" variant="outline">
            Continue with Google
          </Button>
          <Button onClick={handleSlackSignIn} className="w-full" variant="outline">
            Continue with Slack
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
