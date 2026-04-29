import { SignIn } from "@clerk/tanstack-react-start";
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/sign-in/$")({
  component: SignInCatchAllRoute,
});

function SignInCatchAllRoute() {
  return (
    <main className="grid min-h-svh place-items-center bg-background p-4">
      <SignIn signUpUrl="/sign-up" fallbackRedirectUrl="/" path="/sign-in" routing="path" />
    </main>
  );
}
