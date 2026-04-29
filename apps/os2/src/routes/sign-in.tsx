import { SignIn } from "@clerk/tanstack-react-start";
import { createFileRoute } from "@tanstack/react-router";
import { redirectAuthenticatedUserFromAuthRoute } from "~/lib/auth.ts";

export const Route = createFileRoute("/sign-in")({
  loader: () => redirectAuthenticatedUserFromAuthRoute(),
  component: SignInRoute,
});

function SignInRoute() {
  return (
    <main className="grid min-h-svh place-items-center bg-background p-4">
      <SignIn signUpUrl="/sign-up" fallbackRedirectUrl="/" />
    </main>
  );
}
