import { createFileRoute } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { Identifier } from "@iterate-com/ui/components/identifier";
import { orpc } from "~/orpc/client.ts";

export const Route = createFileRoute("/_app/deployments/$slug/")({
  component: DeploymentOverview,
});

function DeploymentOverview() {
  const { slug } = Route.useParams();

  const { data: deployment } = useSuspenseQuery(
    orpc.deployments.get.queryOptions({ input: { slug } }),
  );

  return (
    <div className="h-full overflow-auto p-4">
      <div className="space-y-6">
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          <DetailCard label="ID" value={<Identifier value={deployment.id} />} />
          <DetailCard label="Provider" value={deployment.provider} />
          <DetailCard label="Slug" value={<Identifier value={deployment.slug} />} />
          <DetailCard label="Runtime State" value={deployment.runtime?.state ?? "—"} />
          <DetailCard
            label="Created"
            value={deployment.createdAt ? new Date(deployment.createdAt).toLocaleString() : "—"}
          />
        </div>

        <div className="grid gap-4 xl:grid-cols-2">
          <JsonCard
            label="Provider Status"
            value={
              deployment.runtime?.providerStatus
                ? JSON.stringify(deployment.runtime.providerStatus, null, 2)
                : "null"
            }
          />
          <JsonCard label="Options" value={JSON.stringify(deployment.opts, null, 2)} />
        </div>

        <JsonCard
          label="Deployment Locator"
          value={
            deployment.deploymentLocator
              ? JSON.stringify(deployment.deploymentLocator, null, 2)
              : "null"
          }
        />
      </div>
    </div>
  );
}

function DetailCard({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="rounded-lg border bg-card p-4 space-y-1">
      <div className="text-sm font-medium text-muted-foreground">{label}</div>
      <div className="text-sm">{value}</div>
    </div>
  );
}

function JsonCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="space-y-1">
      <div className="text-sm font-medium text-muted-foreground">{label}</div>
      <pre className="rounded-lg border bg-card p-3 text-sm font-mono overflow-auto">{value}</pre>
    </div>
  );
}
