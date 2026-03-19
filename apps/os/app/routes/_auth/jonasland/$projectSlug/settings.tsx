import { createFileRoute } from "@tanstack/react-router";
import { Settings } from "lucide-react";
import { Card } from "@/components/ui/card.tsx";

export const Route = createFileRoute("/_auth/jonasland/$projectSlug/settings")({
  component: JonasLandSettingsPage,
});

function JonasLandSettingsPage() {
  const params = Route.useParams();

  return (
    <div className="p-4">
      <Card className="p-4">
        <div className="flex items-start gap-4">
          <div className="rounded-lg border bg-muted/50 p-2">
            <Settings className="h-5 w-5" />
          </div>
          <div className="space-y-2">
            <p className="text-sm font-medium">jonasland settings</p>
            <p className="text-sm text-muted-foreground">
              Settings for <span className="font-mono text-foreground">{params.projectSlug}</span>{" "}
              will move here as jonasland grows. This page is a placeholder today.
            </p>
          </div>
        </div>
      </Card>
    </div>
  );
}
