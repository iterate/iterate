import { SignUp } from "@clerk/tanstack-react-start";
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/sign-up/$")({
  component: SignUpCatchAllRoute,
});

function SignUpCatchAllRoute() {
  return (
    <main className="grid min-h-svh place-items-center bg-background p-4">
      {/*
        Clerk's prebuilt SignUp owns nested flow paths such as
        `/sign-up/sso-callback` when mounted on the catch-all route. Keeping the
        callback inside SignUp preserves Clerk's OAuth attempt state; a separate
        AuthenticateWithRedirectCallback route is only for custom OAuth flows.
        https://clerk.com/docs/tanstack-react-start/guides/development/custom-sign-up-page
      */}
      <SignUp signInUrl="/sign-in" fallbackRedirectUrl="/" />
    </main>
  );
}
