import { z } from "zod/v4";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { LoginCard } from "../components/auth-components.tsx";

const redirectIfAuthenticated = createServerFn()
  .inputValidator(z.object({ redirectUrl: z.string().catch("/") }))
  .handler(({ context, data }) => {
    if (context.variables.session) throw redirect({ to: data.redirectUrl });
  });

export const Route = createFileRoute("/login")({
  component: LoginPage,
  validateSearch: z.object({
    redirectUrl: z.string().catch("/"),
  }),
  beforeLoad: ({ search }) =>
    redirectIfAuthenticated({ data: { redirectUrl: search.redirectUrl } }),
});

function LoginPage() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-muted/50">
      <LoginCard />
    </div>
  );
}
