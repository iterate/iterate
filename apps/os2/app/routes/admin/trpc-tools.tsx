import * as React from "react";
import { createFileRoute } from "@tanstack/react-router";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../components/ui/card.tsx";

export const Route = createFileRoute("/_auth-required.layout/_/admin/trpc-tools")({
  component: TrpcToolsPage,
});

function TrpcToolsPage() {
  return (
    <div className="p-8">
      <h1 className="text-2xl font-bold mb-6">tRPC Tools</h1>

      <Card>
        <CardHeader>
          <CardTitle>API Explorer</CardTitle>
          <CardDescription>
            Explore and test tRPC endpoints.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-muted-foreground">
            tRPC tools interface coming soon. For now, use the browser devtools to inspect API calls.
          </p>
          <div className="mt-4 p-4 bg-muted rounded-lg">
            <h4 className="font-medium mb-2">Available Routers:</h4>
            <ul className="list-disc list-inside space-y-1 text-sm text-muted-foreground">
              <li>user - User operations</li>
              <li>organization - Organization CRUD</li>
              <li>instance - Instance management</li>
              <li>machine - Machine CRUD</li>
              <li>admin - Admin operations</li>
              <li>testing - Test helpers</li>
            </ul>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
