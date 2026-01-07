import { createFileRoute } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import { trpc } from "../../lib/trpc.tsx";

export const Route = createFileRoute("/_auth.layout/admin/session-info")({
  component: SessionInfoPage,
});

function SessionInfoPage() {
  const { data: sessionInfo } = useSuspenseQuery(
    trpc.admin.sessionInfo.queryOptions(),
  );

  return (
    <div className="p-8 space-y-6">
      <h1 className="text-2xl font-bold">Session info</h1>

      <section className="space-y-2">
        <h2 className="text-lg font-semibold">Current user</h2>
        <pre className="p-4 bg-muted rounded-lg text-sm overflow-auto">
          {JSON.stringify(sessionInfo?.user, null, 2)}
        </pre>
      </section>

      <section className="space-y-2">
        <h2 className="text-lg font-semibold">Session</h2>
        <pre className="p-4 bg-muted rounded-lg text-sm overflow-auto">
          {JSON.stringify(sessionInfo?.session, null, 2)}
        </pre>
      </section>

      {sessionInfo?.session?.impersonatedBy && (
        <div className="border-l-2 border-border pl-4 space-y-1">
          <div className="text-sm font-medium">Impersonation active</div>
          <p className="text-sm text-muted-foreground">
            Impersonated by{" "}
            <code className="bg-muted px-1 py-0.5 rounded">{sessionInfo.session.impersonatedBy}</code>
          </p>
        </div>
      )}
    </div>
  );
}
