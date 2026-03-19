import { useEffect, useState, type FormEvent } from "react";
import { formatDistanceToNow } from "date-fns";
import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useSuspenseQuery } from "@tanstack/react-query";
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
  const [createOpen, setCreateOpen] = useState(false);
  const [deploymentName, setDeploymentName] = useState("");
  const [transport, setTransport] = useState<"http" | "durable-iterator">("http");

  const deploymentsQueryOptions = orpc.deployment.list.queryOptions({
    input: { projectSlug: params.projectSlug },
  });
  const { data: deployments } = useSuspenseQuery(deploymentsQueryOptions);
  const [liveDeployments, setLiveDeployments] = useState<Array<(typeof deployments)[number]>>(
    () => [...deployments],
  );

  const deploymentStream = useQuery({
    queryKey: [...deploymentsQueryOptions.queryKey, "stream"],
    queryFn: () => orpcClient.deployment.connect({ projectSlug: params.projectSlug }),
    enabled: typeof window !== "undefined",
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: Number.POSITIVE_INFINITY,
    retry: 1,
  });

  useEffect(() => {
    if (!deploymentStream.data) {
      return;
    }

    let active = true;
    const iterator = deploymentStream.data;

    void (async () => {
      try {
        for await (const event of iterator) {
          if (!active) {
            return;
          }

          setTransport("durable-iterator");
          setLiveDeployments(event.deployments);
        }
      } catch (error) {
        if (!active) {
          return;
        }

        setTransport("http");
        toast.error(
          "Failed to sync deployments: " + (error instanceof Error ? error.message : String(error)),
        );
      }
    })();

    return () => {
      active = false;
      void iterator.return();
    };
  }, [deploymentStream.data]);

  const createDeployment = useMutation({
    mutationFn: async () => {
      if (!deploymentStream.data) {
        throw new Error("Deployment stream not ready");
      }

      return deploymentStream.data.deployments.create({ name: deploymentName.trim() });
    },
    onSuccess: () => {
      setCreateOpen(false);
      setDeploymentName("");
      toast.success("Deployment created");
    },
    onError: (error) => {
      toast.error("Failed to create deployment: " + error.message);
    },
  });

  const startDeployment = useMutation({
    mutationFn: async (deploymentId: string) => {
      if (!deploymentStream.data) {
        throw new Error("Deployment stream not ready");
      }

      return deploymentStream.data.deployments.start({ deploymentId });
    },
    onSuccess: () => {
      toast.success("Deployment started");
    },
    onError: (error) => {
      toast.error("Failed to start deployment: " + error.message);
    },
  });

  const stopDeployment = useMutation({
    mutationFn: async (deploymentId: string) => {
      if (!deploymentStream.data) {
        throw new Error("Deployment stream not ready");
      }

      return deploymentStream.data.deployments.stop({ deploymentId });
    },
    onSuccess: () => {
      toast.success("Deployment stopped");
    },
    onError: (error) => {
      toast.error("Failed to stop deployment: " + error.message);
    },
  });

  const destroyDeployment = useMutation({
    mutationFn: async (deploymentId: string) => {
      if (!deploymentStream.data) {
        throw new Error("Deployment stream not ready");
      }

      return deploymentStream.data.deployments.destroy({ deploymentId });
    },
    onSuccess: () => {
      toast.success("Deployment destroyed");
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

  const renderedDeployments = transport === "durable-iterator" ? liveDeployments : deployments;

  return (
    <div
      className="space-y-6 p-4"
      data-component="JonasLandDeploymentsPage"
      data-transport={transport}
    >
      <HeaderActions>
        <Button size="sm" onClick={() => setCreateOpen(true)} disabled={!deploymentStream.data}>
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
              <Button
                type="submit"
                disabled={
                  !deploymentName.trim() || createDeployment.isPending || !deploymentStream.data
                }
              >
                {createDeployment.isPending ? "Creating..." : "Create deployment"}
              </Button>
            </SheetFooter>
          </form>
        </SheetContent>
      </Sheet>

      {renderedDeployments.length === 0 ? (
        <EmptyState
          icon={<Rocket className="h-12 w-12" />}
          title="No deployments yet"
          description="Create a deployment to exercise the new durable object lifecycle."
          action={
            <Button onClick={() => setCreateOpen(true)} disabled={!deploymentStream.data}>
              <Plus className="h-4 w-4" />
              Create deployment
            </Button>
          }
        />
      ) : (
        <div className="space-y-3">
          {renderedDeployments.map((deployment) => (
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
                    disabled={
                      !deploymentStream.data ||
                      deployment.state === "running" ||
                      deployment.state === "destroyed"
                    }
                    onClick={() => startDeployment.mutate(deployment.id)}
                  >
                    Start
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={
                      !deploymentStream.data ||
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
                    disabled={!deploymentStream.data || deployment.state === "destroyed"}
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
