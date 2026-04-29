import { SignUp } from "@clerk/tanstack-react-start";
import { createFileRoute } from "@tanstack/react-router";
import { redirectAuthenticatedUserFromAuthRoute } from "~/lib/auth.ts";

export const Route = createFileRoute("/sign-up")({
  loader: () => redirectAuthenticatedUserFromAuthRoute(),
  component: SignUpRoute,
});

function SignUpRoute() {
  return (
    <main className="grid min-h-svh place-items-center bg-background p-4">
      <SignUp signInUrl="/sign-in" fallbackRedirectUrl="/" />
    </main>
  );
}
