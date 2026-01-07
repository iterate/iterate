import { createFileRoute } from "@tanstack/react-router";
import { Mail, MessageSquare } from "lucide-react";
import { Button } from "../../../components/ui/button.tsx";
import { Badge } from "../../../components/ui/badge.tsx";

export const Route = createFileRoute(
  "/_auth.layout/orgs/$organizationSlug/projects/$projectSlug/connectors",
)({
  component: ProjectConnectorsPage,
});

function ProjectConnectorsPage() {
  return (
    <div className="p-8 max-w-4xl space-y-8">
      <div className="space-y-1">
        <h1 className="text-2xl font-bold">Connectors</h1>
        <p className="text-sm text-muted-foreground">
          OAuth connections will be implemented using Arctic.
        </p>
      </div>

      <section className="space-y-4">
        <div className="space-y-1">
          <h2 className="text-lg font-semibold">Project connections</h2>
          <p className="text-sm text-muted-foreground">Shared across this project.</p>
        </div>
        <div className="space-y-4">
          <div className="flex flex-col gap-4 border-b pb-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-start gap-3">
              <div className="rounded-md border bg-muted p-2">
                <MessageSquare className="h-5 w-5" />
              </div>
              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium">Slack</span>
                  <Badge variant="outline">Not available</Badge>
                </div>
                <p className="text-sm text-muted-foreground">
                  Workspace notifications and commands.
                </p>
              </div>
            </div>
            <Button disabled>Connect Slack</Button>
          </div>
        </div>
      </section>

      <section className="space-y-4">
        <div className="space-y-1">
          <h2 className="text-lg font-semibold">Your connections</h2>
          <p className="text-sm text-muted-foreground">Only visible to you inside this project.</p>
        </div>
        <div className="space-y-4">
          <div className="flex flex-col gap-4 border-b pb-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-start gap-3">
              <div className="rounded-md border bg-muted p-2">
                <Mail className="h-5 w-5" />
              </div>
              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium">Gmail</span>
                  <Badge variant="outline">Not available</Badge>
                </div>
                <p className="text-sm text-muted-foreground">
                  Gmail and Calendar access for your account.
                </p>
              </div>
            </div>
            <Button disabled>Connect Gmail</Button>
          </div>
        </div>
      </section>
    </div>
  );
}
