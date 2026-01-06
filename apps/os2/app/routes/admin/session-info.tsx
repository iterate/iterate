import { createFileRoute } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import { useTRPC } from "../../lib/trpc.ts";
import { Card, CardContent, CardHeader, CardTitle } from "../../components/ui/card.tsx";

export const Route = createFileRoute("/_auth.layout/admin/session-info")({
  component: SessionInfoPage,
});

function SessionInfoPage() {
  const trpc = useTRPC();

  const { data: sessionInfo } = useSuspenseQuery(trpc.admin.getSessionInfo.queryOptions());

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Session Info</h1>

      <Card>
        <CardHeader>
          <CardTitle>User</CardTitle>
        </CardHeader>
        <CardContent>
          <pre className="bg-muted p-4 rounded-lg overflow-auto text-sm">
            {JSON.stringify(sessionInfo.user, null, 2)}
          </pre>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Session</CardTitle>
        </CardHeader>
        <CardContent>
          <pre className="bg-muted p-4 rounded-lg overflow-auto text-sm">
            {JSON.stringify(sessionInfo.session, null, 2)}
          </pre>
        </CardContent>
      </Card>
    </div>
  );
}
