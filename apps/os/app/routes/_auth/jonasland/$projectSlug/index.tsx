import { createFileRoute } from "@tanstack/react-router";
import { Box } from "lucide-react";
import { Card } from "@/components/ui/card.tsx";

export const Route = createFileRoute("/_auth/jonasland/$projectSlug/")({
  component: JonasLandProjectHomePage,
});

function JonasLandProjectHomePage() {
  const params = Route.useParams();

  return (
    <div className="p-4" data-component="JonasLandProjectHomePage">
      <Card className="p-4">
        <div className="flex items-start gap-4">
          <div className="rounded-lg border bg-muted/50 p-2">
            <Box className="h-5 w-5" />
          </div>
          <div className="space-y-2">
            <p className="text-sm font-medium">jonasland project home</p>
            <p className="text-sm text-muted-foreground">
              Project <span className="font-mono text-foreground">{params.projectSlug}</span> is
              using the jonasland renderer. This is the placeholder home page for the new route
              tree.
            </p>
          </div>
        </div>
      </Card>
    </div>
  );
}
