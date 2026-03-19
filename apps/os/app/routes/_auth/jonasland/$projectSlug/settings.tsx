import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/_auth/jonasland/$projectSlug/settings")({
  component: JonasLandSettingsPage,
});

function JonasLandSettingsPage() {
  const params = Route.useParams();

  return (
    <div className="space-y-2 p-4">
      <p className="text-sm font-medium">settings</p>
      <p className="max-w-md text-sm text-muted-foreground">
        Settings for <span className="font-mono text-foreground">{params.projectSlug}</span> will
        move here as jonasland grows. This page is a placeholder today.
      </p>
    </div>
  );
}
