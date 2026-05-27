import { createFileRoute } from "@tanstack/react-router";
import { Button } from "@iterate-com/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@iterate-com/ui/components/card";
import { useAuthClient } from "~/auth/client-context.ts";

export const Route = createFileRoute("/sign-in/$")({
  component: SignInRoute,
});

function SignInRoute() {
  const { signIn } = useAuthClient();

  return (
    <main className="grid min-h-svh place-items-center bg-background p-4">
      <Card className="w-full max-w-sm">
        <CardHeader className="text-center">
          <CardTitle className="text-xl">Sign in to OS</CardTitle>
          <CardDescription>Continue with Iterate to open your workspace.</CardDescription>
        </CardHeader>
        <CardContent>
          <Button className="w-full" size="lg" onClick={signIn}>
            Continue with Iterate
          </Button>
        </CardContent>
      </Card>
    </main>
  );
}
