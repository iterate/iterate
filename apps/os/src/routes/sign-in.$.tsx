import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { buttonVariants } from "@iterate-com/ui/components/button";
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
  const { redirect_url: redirectUrl } = Route.useSearch();
  const returnTo = safeRedirectPath(redirectUrl);
  const signInUrl = `/api/iterate-auth/login?return_to=${encodeURIComponent(returnTo)}`;

  return (
    <main className="grid min-h-svh place-items-center bg-background p-4">
      <Card className="w-full max-w-sm">
        <CardHeader className="text-center">
          <CardTitle className="text-xl">Sign in to OS</CardTitle>
          <CardDescription>Continue with Iterate to open your projects.</CardDescription>
        </CardHeader>
        <CardContent>
          <a
            data-slot="button"
            className={buttonVariants({ className: "w-full", size: "lg" })}
            href={signInUrl}
          >
            Continue with Iterate
          </a>
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
