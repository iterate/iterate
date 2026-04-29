import { SignUp } from "@clerk/tanstack-react-start";
import { Outlet, createFileRoute, useLocation } from "@tanstack/react-router";
import { redirectAuthenticatedUserFromAuthRoute } from "~/lib/auth.ts";

export const Route = createFileRoute("/sign-up")({
  loader: () => redirectAuthenticatedUserFromAuthRoute(),
  component: SignUpRoute,
});

function SignUpRoute() {
  const location = useLocation();
  const isNestedRoute = location.pathname !== "/sign-up";

  return (
    <main className="grid min-h-svh place-items-center bg-background p-4">
      {isNestedRoute ? <Outlet /> : <SignUp signInUrl="/sign-in" forceRedirectUrl="/" />}
    </main>
  );
}
