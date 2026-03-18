import { useEffect } from "react";
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/_app/")({
  component: AppIndexRedirect,
});

function AppIndexRedirect() {
  const navigate = Route.useNavigate();

  useEffect(() => {
    void navigate({ to: "/debug", replace: true });
  }, [navigate]);

  return <div className="p-4 text-sm text-muted-foreground">Redirecting to debug...</div>;
}
