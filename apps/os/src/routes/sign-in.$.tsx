import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { useAuthClient } from "@iterate-com/auth/client";
import { Button } from "@iterate-com/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@iterate-com/ui/components/card";

export const Route = createFileRoute("/sign-in/$")({
  validateSearch: z.looseObject({
    redirect_url: z.string().optional(),
  }),
  component: SignInRoute,
});

function SignInRoute() {
  const { signIn } = useAuthClient();
  const { redirect_url: redirectUrl } = Route.useSearch();
  const returnTo = safeRedirectPath(redirectUrl);
  const [redirecting, setRedirecting] = useState(false);

  return (
    <main className="grid min-h-svh place-items-center bg-background p-4">
      <Card className="w-full max-w-sm">
        <CardHeader className="text-center">
          <CardTitle className="text-xl">Sign in to OS</CardTitle>
          <CardDescription>Continue with Iterate to open your projects.</CardDescription>
        </CardHeader>
        <CardContent>
          <Button
            className="w-full"
            size="lg"
            disabled={redirecting}
            onClick={() => {
              setRedirecting(true);
              signIn({ returnTo });
            }}
          >
            {redirecting ? "Redirecting…" : "Continue with Iterate"}
          </Button>
        </CardContent>
      </Card>
    </main>
  );
}

function safeRedirectPath(rawRedirect: string | null | undefined) {
  const fallback = "/";
  const trimmed = rawRedirect?.trim();
  if (!trimmed || !trimmed.startsWith("/") || trimmed.startsWith("//")) {
    return fallback;
  }

  try {
    const parsed = new URL(trimmed, "https://iterate-os.local");
    if (parsed.origin !== "https://iterate-os.local") return fallback;
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return fallback;
  }
}
