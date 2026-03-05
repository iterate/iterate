import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useSuspenseQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Suspense } from "react";
import { Loader2Icon, TrashIcon } from "lucide-react";
import { Button } from "@iterate-com/ui/components/button";
import { orpc, orpcClient } from "@/lib/orpc.ts";

export const Route = createFileRoute("/_app/deployments/$slug")({
  component: DeploymentPage,
});

function DeploymentPage() {
  return (
    <Suspense
      fallback={
        <div className="flex items-center justify-center h-32">
          <Loader2Icon className="size-6 animate-spin text-muted-foreground" />
        </div>
      }
    >
      <DeploymentDetail />
    </Suspense>
  );
}

function DeploymentDetail() {
  const { slug } = Route.useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const { data: deployment } = useSuspenseQuery(
    orpc.deployments.get.queryOptions({ input: { slug } }),
  );

  const deleteMutation = useMutation(
    orpc.deployments.delete.mutationOptions({
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: orpc.deployments.list.key() });
        navigate({ to: "/deployments" });
      },
    }),
  );

  return (
    <div className="mx-auto max-w-md">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold">{deployment.slug}</h1>
        <Button
          variant="destructive"
          size="sm"
          onClick={() => deleteMutation.mutate({ slug: deployment.slug })}
          disabled={deleteMutation.isPending}
        >
          <TrashIcon className="size-4 mr-1" />
          {deleteMutation.isPending ? "Deleting..." : "Delete"}
        </Button>
      </div>

      <div className="space-y-4">
        <DetailRow label="ID" value={deployment.id} />
        <DetailRow label="Provider" value={deployment.provider} />
        <DetailRow label="Slug" value={deployment.slug} />
        <DetailRow
          label="Created"
          value={deployment.createdAt ? new Date(deployment.createdAt).toLocaleString() : "—"}
        />

        <div className="space-y-1">
          <div className="text-sm font-medium text-muted-foreground">Options</div>
          <pre className="rounded-lg border bg-card p-3 text-sm font-mono overflow-auto">
            {JSON.stringify(deployment.opts, null, 2)}
          </pre>
        </div>

        <div className="space-y-1">
          <div className="text-sm font-medium text-muted-foreground">Deployment Locator</div>
          <pre className="rounded-lg border bg-card p-3 text-sm font-mono overflow-auto">
            {deployment.deploymentLocator
              ? JSON.stringify(deployment.deploymentLocator, null, 2)
              : "null"}
          </pre>
        </div>
      </div>
    </div>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="space-y-1">
      <div className="text-sm font-medium text-muted-foreground">{label}</div>
      <div className="text-sm font-mono">{value}</div>
    </div>
  );
}
