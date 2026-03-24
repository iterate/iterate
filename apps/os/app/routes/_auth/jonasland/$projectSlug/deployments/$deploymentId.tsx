import { formatDistanceToNow } from "date-fns";
import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { Globe, Logs, Star } from "lucide-react";
import { toast } from "sonner";
import { HeaderActions } from "@/components/header-actions.tsx";
import { Button } from "@/components/ui/button.tsx";
import { orpc } from "@/lib/orpc.tsx";

export const Route = createFileRoute("/_auth/jonasland/$projectSlug/deployments/$deploymentId")({
  loader: async ({ context, params }) => {
    await context.queryClient.ensureQueryData(
      orpc.deployment.get.queryOptions({
        input: {
          projectSlug: params.projectSlug,
          deploymentId: params.deploymentId,
        },
      }),
    );
  },
  component: JonasLandDeploymentDetailPage,
});

function JonasLandDeploymentDetailPage() {
  const params = Route.useParams();
  const queryClient = useQueryClient();
  const detailQueryOptions = orpc.deployment.get.queryOptions({
    input: {
      projectSlug: params.projectSlug,
      deploymentId: params.deploymentId,
    },
  });
  const listQueryKey = orpc.deployment.list.key({
    input: { projectSlug: params.projectSlug },
  });
  const detailQueryKey = orpc.deployment.get.key({
    input: {
      projectSlug: params.projectSlug,
      deploymentId: params.deploymentId,
    },
  });
  const { data: detail } = useSuspenseQuery(detailQueryOptions);
  const logsQuery = useQuery(
    orpc.deployment.logs.experimental_streamedOptions({
      input: {
        projectSlug: params.projectSlug,
        deploymentId: params.deploymentId,
      },
      enabled: typeof window !== "undefined",
      retry: true,
      queryFnOptions: {
        refetchMode: "reset",
        maxChunks: 200,
      },
    }),
  );
  const deployment = detail.deployment;
  const isPrimary = detail.isPrimary;
  const logs = logsQuery.data ?? [];

  const refreshDeploymentQueries = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: detailQueryKey }),
      queryClient.invalidateQueries({ queryKey: listQueryKey }),
    ]);
  };

  const startDeployment = useMutation(
    orpc.deployment.start.mutationOptions({
      onSuccess: async () => {
        await refreshDeploymentQueries();
        toast.success("Deployment started");
      },
      onError: (error) => {
        toast.error("Failed to start deployment: " + error.message);
      },
    }),
  );

  const stopDeployment = useMutation(
    orpc.deployment.stop.mutationOptions({
      onSuccess: async () => {
        await refreshDeploymentQueries();
        toast.success("Deployment stopped");
      },
      onError: (error) => {
        toast.error("Failed to stop deployment: " + error.message);
      },
    }),
  );

  const destroyDeployment = useMutation(
    orpc.deployment.destroy.mutationOptions({
      onSuccess: async () => {
        await refreshDeploymentQueries();
        toast.success("Deployment destroyed");
      },
      onError: (error) => {
        toast.error("Failed to destroy deployment: " + error.message);
      },
    }),
  );

  return (
    <div
      className="space-y-6 p-4"
      data-component="JonasLandDeploymentDetailPage"
      data-deployment-id={deployment.id}
      data-deployment-state={deployment.state}
    >
      <HeaderActions>
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={
              deployment.state === "starting" ||
              deployment.state === "running" ||
              deployment.state === "destroyed"
            }
            onClick={() =>
              startDeployment.mutate({
                projectSlug: params.projectSlug,
                deploymentId: params.deploymentId,
              })
            }
          >
            Start
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={
              deployment.state === "created" ||
              deployment.state === "stopped" ||
              deployment.state === "destroyed"
            }
            onClick={() =>
              stopDeployment.mutate({
                projectSlug: params.projectSlug,
                deploymentId: params.deploymentId,
              })
            }
          >
            Stop
          </Button>
          <Button
            size="sm"
            variant="destructive"
            disabled={deployment.state === "destroyed"}
            onClick={() =>
              destroyDeployment.mutate({
                projectSlug: params.projectSlug,
                deploymentId: params.deploymentId,
              })
            }
          >
            Destroy
          </Button>
        </div>
      </HeaderActions>

      <div className="space-y-4">
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <p className="text-sm font-medium">{deployment.name}</p>
            {isPrimary && (
              <span className="inline-flex items-center gap-1 text-xs text-foreground">
                <Star className="h-3.5 w-3.5 fill-current" />
                Primary
              </span>
            )}
          </div>
          <p className="text-sm text-muted-foreground">
            {deployment.state} · updated{" "}
            {formatDistanceToNow(new Date(deployment.updatedAt), { addSuffix: true })}
          </p>
          <div className="space-y-1 rounded-lg border p-3">
            <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              <Globe className="h-3.5 w-3.5" />
              Ingress host
            </div>
            <p className="font-mono text-sm">{deployment.ingressHost}</p>
          </div>
          <p className="font-mono text-xs text-muted-foreground">{deployment.id}</p>
        </div>

        <div className="space-y-2">
          <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            <Logs className="h-3.5 w-3.5" />
            Live logs
          </div>
          <div className="overflow-hidden rounded-lg border bg-black text-zinc-100">
            <div className="max-h-[420px] overflow-y-auto p-3 font-mono text-xs leading-5">
              {logs.map((log: (typeof logs)[number]) => (
                <div key={log.id} data-log-line={log.id}>
                  <span className="text-zinc-500">
                    {new Date(log.createdAt).toLocaleTimeString("en-GB", {
                      hour: "2-digit",
                      minute: "2-digit",
                      second: "2-digit",
                    })}
                  </span>{" "}
                  <span
                    className={
                      log.level === "error"
                        ? "text-red-300"
                        : log.level === "warn"
                          ? "text-amber-300"
                          : "text-emerald-300"
                    }
                  >
                    [{log.level}]
                  </span>{" "}
                  <span>{log.message}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
