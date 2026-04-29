import { SignUp } from "@clerk/tanstack-react-start";
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/sign-up/$")({
  component: SignUpCatchAllRoute,
});

function SignUpCatchAllRoute() {
  return (
    <main className="grid min-h-svh place-items-center bg-background p-4">
      <SignUp signInUrl="/sign-in" fallbackRedirectUrl="/" path="/sign-up" routing="path" />
    </main>
  );
}
