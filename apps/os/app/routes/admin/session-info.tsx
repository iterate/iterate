import { useSuspenseQuery } from "@tanstack/react-query";
import { useTRPC } from "../../lib/trpc.ts";

export default function SessionInfoPage() {
  const trpc = useTRPC();
  const { data: sessionInfo } = useSuspenseQuery(trpc.admin.getSessionInfo.queryOptions());

  return (
    <div className="p-6 space-y-6">
      <div>
        <h2 className="text-2xl font-bold">Session Information</h2>
        <p className="text-muted-foreground">Current user and session details</p>
      </div>

      <div className="space-y-2">
        <div className="font-semibold">User</div>
        <div className="text-sm text-muted-foreground">Information about the current user</div>
        <pre className="bg-muted p-4 rounded-lg text-xs overflow-auto border">
          {JSON.stringify(sessionInfo?.user, null, 2)}
        </pre>
      </div>

      <div className="space-y-2">
        <div className="font-semibold">Session</div>
        <div className="text-sm text-muted-foreground">Current session data</div>
        <pre className="bg-muted p-4 rounded-lg text-xs overflow-auto border">
          {JSON.stringify(sessionInfo?.session, null, 2)}
        </pre>
      </div>
    </div>
  );
}
