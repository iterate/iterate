import { useEffect } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod/v4";
import { Button } from "@iterate-com/ui/components/button";
import { useAuthClient } from "~/auth/client-context.ts";

export const Route = createFileRoute("/sign-in/$")({
  validateSearch: z.looseObject({
    logged_out: z.union([z.boolean(), z.string()]).optional(),
  }),
  component: SignInRoute,
});

function SignInRoute() {
  const { signIn } = useAuthClient();
  const { logged_out } = Route.useSearch();
  const isLoggedOutReturn = logged_out === true || logged_out === "true";

  useEffect(() => {
    if (!isLoggedOutReturn) {
      signIn();
    }
  }, [isLoggedOutReturn, signIn]);

  return (
    <main className="grid min-h-svh place-items-center bg-background p-4">
      {isLoggedOutReturn ? (
        <Button size="lg" onClick={signIn}>
          Sign in
        </Button>
      ) : null}
    </main>
  );
}
