import { createFileRoute, redirect } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";

const signOutAndRedirect = createServerFn({ method: "POST" }).handler(async ({ context }) => {
  const request = getRequest();
  await context.variables.auth.api.signOut({ headers: request.headers });
  throw redirect({ to: "/login", search: { redirectUrl: "/" } });
});

export const Route = createFileRoute("/logout")({
  beforeLoad: () => signOutAndRedirect(),
  component: LogoutPage,
});

function LogoutPage() {
  return null;
}
