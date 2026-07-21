import { useEffect } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";

/**
 * Legacy URL: new-agent composition lives on the project dashboard (home).
 * Keep this path so old bookmarks and sidebar links resolve cleanly.
 */
export const Route = createFileRoute("/_app/projects/$projectSlug/agents/new")({
  staticData: { breadcrumb: "New agent" },
  ssr: false,
  component: NewAgentRedirect,
});

function NewAgentRedirect() {
  const { projectSlug } = Route.useParams();
  const navigate = useNavigate();

  useEffect(() => {
    void navigate({
      to: "/projects/$projectSlug",
      params: { projectSlug },
      search: {},
      replace: true,
    });
  }, [navigate, projectSlug]);

  return (
    <main className="flex min-h-full flex-1 items-center justify-center p-4 text-sm text-muted-foreground">
      Opening project home…
    </main>
  );
}
