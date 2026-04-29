import { AuthenticateWithRedirectCallback } from "@clerk/tanstack-react-start";
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/sign-up/sso-callback")({
  component: SignUpSSOCallbackRoute,
});

function SignUpSSOCallbackRoute() {
  return (
    <main className="grid min-h-svh place-items-center bg-background p-4">
      <AuthenticateWithRedirectCallback
        signInUrl="/sign-in"
        signUpUrl="/sign-up"
        continueSignUpUrl="/sign-up"
        signInForceRedirectUrl="/"
        signUpForceRedirectUrl="/"
      />
    </main>
  );
}
