import { SignIn } from "@clerk/tanstack-react-start";
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/sign-in/$")({
  component: SignInCatchAllRoute,
});

function SignInCatchAllRoute() {
  return (
    <main className="grid min-h-svh place-items-center bg-background p-4">
      {/*
        Clerk's prebuilt SignIn owns nested flow paths such as
        `/sign-in/sso-callback` when mounted on the catch-all route. Keeping the
        callback inside SignIn preserves Clerk's OAuth attempt state; a separate
        AuthenticateWithRedirectCallback route is only for custom OAuth flows.
        https://clerk.com/docs/tanstack-react-start/guides/development/custom-sign-in-or-up-page
      */}
      <SignIn signUpUrl="/sign-up" fallbackRedirectUrl="/" />
    </main>
  );
}
