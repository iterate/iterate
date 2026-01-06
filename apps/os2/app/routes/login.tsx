import { createFileRoute, Navigate } from "@tanstack/react-router";
import { LoginCard } from "../components/auth-components.tsx";
import { useSessionUser } from "../hooks/use-session-user.ts";

export const Route = createFileRoute("/login")({
  component: LoginPage,
});

function LoginPage() {
  const { isAuthenticated, isLoading } = useSessionUser();

  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="text-muted-foreground">Loading...</div>
      </div>
    );
  }

  if (isAuthenticated) {
    return <Navigate to="/" />;
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-muted/50">
      <LoginCard />
    </div>
  );
}
