import { useSuspenseQuery } from "@tanstack/react-query";
import { useTRPC } from "../lib/trpc.ts";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../components/ui/card.tsx";

export default function SessionInfoPage() {
  const trpc = useTRPC();
  const { data: sessionInfo } = useSuspenseQuery(trpc.admin.getSessionInfo.queryOptions());

  return (
    <div className="container mx-auto p-6 space-y-6">
      <div>
        <h2 className="text-2xl font-bold">Session Information</h2>
        <p className="text-muted-foreground">Current user and session details</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>User</CardTitle>
          <CardDescription>Information about the current user</CardDescription>
        </CardHeader>
        <CardContent>
          <pre className="bg-muted p-4 rounded-lg text-xs overflow-auto">
            {JSON.stringify(sessionInfo?.user, null, 2)}
          </pre>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Session</CardTitle>
          <CardDescription>Current session data</CardDescription>
        </CardHeader>
        <CardContent>
          <pre className="bg-muted p-4 rounded-lg text-xs overflow-auto">
            {JSON.stringify(sessionInfo?.session, null, 2)}
          </pre>
        </CardContent>
      </Card>
    </div>
  );
}
