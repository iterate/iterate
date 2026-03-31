import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/_auth/jonasland/$projectSlug/")({
  component: JonasLandProjectHomePage,
});

function JonasLandProjectHomePage() {
  const params = Route.useParams();

  return (
    <div className="space-y-2 p-4" data-component="JonasLandProjectHomePage">
      <p className="text-sm font-medium">jonasland</p>
      <p className="max-w-md text-sm text-muted-foreground">
        Project <span className="font-mono text-foreground">{params.projectSlug}</span> is using the
        jonasland renderer. This is the placeholder home page for the new route tree.
      </p>
    </div>
  );
}
