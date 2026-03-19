import { useState, type FormEvent } from "react";
import { formatDistanceToNow } from "date-fns";
import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { Plus, Rocket } from "lucide-react";
import { toast } from "sonner";
import { EmptyState } from "@/components/empty-state.tsx";
import { HeaderActions } from "@/components/header-actions.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Card, CardContent } from "@/components/ui/card.tsx";
import { Field, FieldGroup, FieldLabel, FieldSet } from "@/components/ui/field.tsx";
import { Input } from "@/components/ui/input.tsx";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet.tsx";
import { orpc, orpcClient } from "@/lib/orpc.tsx";

export const Route = createFileRoute("/_auth/jonasland/$projectSlug/deployments")({
  loader: ({ context, params }) => {
    context.queryClient.prefetchQuery(
      orpc.deployment.list.queryOptions({
        input: { projectSlug: params.projectSlug },
      }),
    );
  },
  component: JonasLandDeploymentsPage,
});

function JonasLandDeploymentsPage() {
  const params = Route.useParams();
  const queryClient = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [deploymentName, setDeploymentName] = useState("");

  const deploymentsQueryOptions = orpc.deployment.list.queryOptions({
    input: { projectSlug: params.projectSlug },
  });
  const { data: deployments } = useSuspenseQuery(deploymentsQueryOptions);

  const createDeployment = useMutation({
    mutationFn: () =>
      orpcClient.deployment.create({
        projectSlug: params.projectSlug,
        name: deploymentName.trim(),
      }),
    onSuccess: async () => {
      setCreateOpen(false);
      setDeploymentName("");
      toast.success("Deployment created");
      await queryClient.invalidateQueries({ queryKey: deploymentsQueryOptions.queryKey });
    },
    onError: (error) => {
      toast.error("Failed to create deployment: " + error.message);
    },
  });

  const startDeployment = useMutation({
    mutationFn: (deploymentId: string) =>
      orpcClient.deployment.start({
        projectSlug: params.projectSlug,
        deploymentId,
      }),
    onSuccess: async () => {
      toast.success("Deployment started");
      await queryClient.invalidateQueries({ queryKey: deploymentsQueryOptions.queryKey });
    },
    onError: (error) => {
      toast.error("Failed to start deployment: " + error.message);
    },
  });

  const stopDeployment = useMutation({
    mutationFn: (deploymentId: string) =>
      orpcClient.deployment.stop({
        projectSlug: params.projectSlug,
        deploymentId,
      }),
    onSuccess: async () => {
      toast.success("Deployment stopped");
      await queryClient.invalidateQueries({ queryKey: deploymentsQueryOptions.queryKey });
    },
    onError: (error) => {
      toast.error("Failed to stop deployment: " + error.message);
    },
  });

  const destroyDeployment = useMutation({
    mutationFn: (deploymentId: string) =>
      orpcClient.deployment.destroy({
        projectSlug: params.projectSlug,
        deploymentId,
      }),
    onSuccess: async () => {
      toast.success("Deployment destroyed");
      await queryClient.invalidateQueries({ queryKey: deploymentsQueryOptions.queryKey });
    },
    onError: (error) => {
      toast.error("Failed to destroy deployment: " + error.message);
    },
  });

  const handleCreateDeployment = (event: FormEvent) => {
    event.preventDefault();
    if (!deploymentName.trim()) {
      return;
    }
    createDeployment.mutate();
  };

  return (
    <div className="space-y-6 p-4" data-component="JonasLandDeploymentsPage">
      <HeaderActions>
        <Button size="sm" onClick={() => setCreateOpen(true)}>
          <Plus className="h-4 w-4" />
          New deployment
        </Button>
      </HeaderActions>

      <Sheet open={createOpen} onOpenChange={setCreateOpen}>
        <SheetContent>
          <SheetHeader>
            <SheetTitle>New deployment</SheetTitle>
            <SheetDescription>
              Create a jonasland deployment for {params.projectSlug}.
            </SheetDescription>
          </SheetHeader>
          <form className="flex h-full flex-col" onSubmit={handleCreateDeployment}>
            <FieldGroup>
              <FieldSet>
                <Field>
                  <FieldLabel htmlFor="deployment-name">Deployment name</FieldLabel>
                  <Input
                    id="deployment-name"
                    value={deploymentName}
                    onChange={(event) => setDeploymentName(event.target.value)}
                    disabled={createDeployment.isPending}
                    autoFocus
                  />
                </Field>
              </FieldSet>
            </FieldGroup>
            <SheetFooter>
              <Button type="submit" disabled={!deploymentName.trim() || createDeployment.isPending}>
                {createDeployment.isPending ? "Creating..." : "Create deployment"}
              </Button>
            </SheetFooter>
          </form>
        </SheetContent>
      </Sheet>

      {deployments.length === 0 ? (
        <EmptyState
          icon={<Rocket className="h-12 w-12" />}
          title="No deployments yet"
          description="Create a deployment to exercise the new durable object lifecycle."
          action={
            <Button onClick={() => setCreateOpen(true)}>
              <Plus className="h-4 w-4" />
              Create deployment
            </Button>
          }
        />
      ) : (
        <div className="space-y-3">
          {deployments.map((deployment) => (
            <Card
              key={deployment.id}
              className="border rounded-lg"
              data-deployment-id={deployment.id}
            >
              <CardContent className="flex items-start justify-between gap-4 p-4 pt-4">
                <div className="min-w-0 flex-1 space-y-2">
                  <div className="flex items-center gap-2">
                    <span
                      className={[
                        "size-2.5 rounded-full",
                        deployment.state === "running"
                          ? "bg-emerald-500"
                          : deployment.state === "destroyed"
                            ? "bg-red-500"
                            : deployment.state === "stopped"
                              ? "bg-amber-500"
                              : "bg-blue-500",
                      ].join(" ")}
                    />
                    <p className="font-medium">{deployment.name}</p>
                  </div>
                  <p
                    className="text-sm text-muted-foreground"
                    data-deployment-state={deployment.state}
                  >
                    {deployment.state} · updated{" "}
                    {formatDistanceToNow(new Date(deployment.updatedAt), { addSuffix: true })}
                  </p>
                  <p className="truncate text-xs text-muted-foreground">{deployment.id}</p>
                </div>

                <div className="flex shrink-0 flex-wrap gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={deployment.state === "running" || deployment.state === "destroyed"}
                    onClick={() => startDeployment.mutate(deployment.id)}
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
                    onClick={() => stopDeployment.mutate(deployment.id)}
                  >
                    Stop
                  </Button>
                  <Button
                    size="sm"
                    variant="destructive"
                    disabled={deployment.state === "destroyed"}
                    onClick={() => destroyDeployment.mutate(deployment.id)}
                  >
                    Destroy
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
