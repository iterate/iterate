import { createFileRoute, redirect } from "@tanstack/react-router";
import { LoginCard } from "../components/auth-components.tsx";
import { sessionQueryOptions } from "../lib/session-query.ts";

export const Route = createFileRoute("/login")({
  beforeLoad: async ({ context }) => {
    const session = await context.queryClient.ensureQueryData(sessionQueryOptions());
    if (session?.user) {
      throw redirect({ to: "/" });
    }
  },
  component: LoginPage,
});

function LoginPage() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-muted/50">
      <LoginCard />
    </div>
  );
}
