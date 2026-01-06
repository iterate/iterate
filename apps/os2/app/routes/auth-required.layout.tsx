import { createFileRoute, Outlet, Navigate } from "@tanstack/react-router";
import { useSessionUser } from "../hooks/use-session-user.ts";

export const Route = createFileRoute("/_auth-required.layout")({
  component: AuthRequiredLayout,
});

function AuthRequiredLayout() {
  const { isAuthenticated, isLoading } = useSessionUser();

  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="text-muted-foreground">Loading...</div>
      </div>
    );
  }

  if (!isAuthenticated) {
    return <Navigate to="/login" />;
  }

  return <Outlet />;
}
