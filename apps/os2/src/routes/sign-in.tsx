import { SignIn } from "@clerk/tanstack-react-start";
import { Outlet, createFileRoute, useLocation } from "@tanstack/react-router";
import { redirectAuthenticatedUserFromAuthRoute } from "~/lib/auth.ts";

export const Route = createFileRoute("/sign-in")({
  loader: () => redirectAuthenticatedUserFromAuthRoute(),
  component: SignInRoute,
});

function SignInRoute() {
  const location = useLocation();
  const isNestedRoute = location.pathname !== "/sign-in";

  return (
    <main className="grid min-h-svh place-items-center bg-background p-4">
      {isNestedRoute ? <Outlet /> : <SignIn signUpUrl="/sign-up" forceRedirectUrl="/" />}
    </main>
  );
}
