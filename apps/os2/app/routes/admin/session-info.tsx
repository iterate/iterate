import * as React from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { trpc } from "../../lib/trpc.ts";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../components/ui/card.tsx";

export const Route = createFileRoute("/_auth-required.layout/_/admin/session-info")({
  component: SessionInfoPage,
});

function SessionInfoPage() {
  const { data: sessionInfo, isLoading } = useQuery(
    trpc.admin.sessionInfo.queryOptions(),
  );

  if (isLoading) {
    return (
      <div className="p-8">
        <div className="text-muted-foreground">Loading...</div>
      </div>
    );
  }

  return (
    <div className="p-8">
      <h1 className="text-2xl font-bold mb-6">Session Info</h1>

      <div className="grid gap-6">
        <Card>
          <CardHeader>
            <CardTitle>Current User</CardTitle>
            <CardDescription>Information about the currently logged in user</CardDescription>
          </CardHeader>
          <CardContent>
            <pre className="p-4 bg-muted rounded-lg text-sm overflow-auto">
              {JSON.stringify(sessionInfo?.user, null, 2)}
            </pre>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Session</CardTitle>
            <CardDescription>Session details</CardDescription>
          </CardHeader>
          <CardContent>
            <pre className="p-4 bg-muted rounded-lg text-sm overflow-auto">
              {JSON.stringify(sessionInfo?.session, null, 2)}
            </pre>
          </CardContent>
        </Card>

        {sessionInfo?.session?.impersonatedBy && (
          <Card className="border-yellow-500">
            <CardHeader>
              <CardTitle className="text-yellow-600">Impersonation Active</CardTitle>
              <CardDescription>
                You are currently impersonating another user
              </CardDescription>
            </CardHeader>
            <CardContent>
              <p className="text-sm">
                Impersonated by: <code className="bg-muted px-1 py-0.5 rounded">{sessionInfo.session.impersonatedBy}</code>
              </p>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
