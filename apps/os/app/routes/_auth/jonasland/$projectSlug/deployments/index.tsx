import { useEffect, useEffectEvent, useState, type FormEvent } from "react";
import { formatDistanceToNow } from "date-fns";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { ExternalLink, Plus, Rocket, Star } from "lucide-react";
import { toast } from "sonner";
import { EmptyState } from "@/components/empty-state.tsx";
import { HeaderActions } from "@/components/header-actions.tsx";
import { Button } from "@/components/ui/button.tsx";
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

export const Route = createFileRoute("/_auth/jonasland/$projectSlug/deployments/")({
  loader: async ({ context, params }) => {
    await context.queryClient.ensureQueryData(
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
  const [transport, setTransport] = useState<"http" | "durable-iterator">("http");

  const listQueryOptions = orpc.deployment.list.queryOptions({
    input: { projectSlug: params.projectSlug },
  });
  const listQueryKey = listQueryOptions.queryKey;
  const { data: deployments } = useSuspenseQuery(listQueryOptions);
  const setDeploymentsCache = useEffectEvent(
    (nextDeployments: Array<(typeof deployments)[number]>) => {
      queryClient.setQueryData(listQueryKey, (current: typeof deployments | undefined) =>
        Object.assign([...nextDeployments], {
          [Symbol.dispose]: current?.[Symbol.dispose] ?? (() => {}),
        }),
      );
    },
  );

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    let active = true;
    let iterator: Awaited<ReturnType<typeof orpcClient.deployment.connectProject>> | null = null;

    void (async () => {
      try {
        iterator = await orpcClient.deployment.connectProject({ projectSlug: params.projectSlug });
        if (!active) {
          return;
        }

        setTransport("durable-iterator");

        for await (const event of iterator) {
          if (!active) {
            return;
          }

          // TanStack Query still owns the deployments collection. The websocket side effect
          // only hydrates that cache with fresher project snapshots from the DO.
          setDeploymentsCache(event.deployments);
        }
      } catch {
        if (!active) {
          return;
        }

        setTransport("http");
      }
    })();

    return () => {
      active = false;
      void iterator?.return();
    };
  }, [params.projectSlug, queryClient, listQueryKey]);

  const createDeployment = useMutation({
    mutationFn: async () => {
      return orpcClient.deployment.create({
        projectSlug: params.projectSlug,
        name: deploymentName.trim(),
      });
    },
    onSuccess: (nextDeployments) => {
      setDeploymentsCache(nextDeployments);
      setCreateOpen(false);
      setDeploymentName("");
      toast.success("Deployment created");
    },
    onError: (error) => {
      toast.error("Failed to create deployment: " + error.message);
    },
  });

  const makePrimary = useMutation({
    mutationFn: async (deploymentId: string) => {
      return orpcClient.deployment.makePrimary({
        projectSlug: params.projectSlug,
        deploymentId,
      });
    },
    onSuccess: (nextDeployments) => {
      setDeploymentsCache(nextDeployments);
      toast.success("Primary deployment updated");
    },
    onError: (error) => {
      toast.error("Failed to make deployment primary: " + error.message);
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
    <div
      className="space-y-6 p-4"
      data-component="JonasLandDeploymentsPage"
      data-transport={transport}
    >
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
              Create a new deployment for {params.projectSlug}. The new deployment becomes primary
              by default.
            </SheetDescription>
          </SheetHeader>
          <form className="flex h-full flex-col" onSubmit={handleCreateDeployment}>
            <div className="flex-1 p-4 pt-0">
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
            </div>
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
          description="Create a deployment to establish a primary ingress host and a live deployment stream."
          action={
            <Button onClick={() => setCreateOpen(true)}>
              <Plus className="h-4 w-4" />
              Create deployment
            </Button>
          }
        />
      ) : (
        <div className="overflow-hidden rounded-lg border">
          {deployments.map((deployment, index) => (
            <div
              key={deployment.id}
              className={[
                "flex items-start justify-between gap-4 p-4",
                index > 0 ? "border-t" : "",
              ].join(" ")}
              data-deployment-id={deployment.id}
              data-deployment-name={deployment.name}
              data-deployment-state={deployment.state}
              data-primary={deployment.isPrimary ? "true" : "false"}
            >
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
                            : deployment.state === "starting" || deployment.state === "stopping"
                              ? "bg-blue-500"
                              : deployment.state === "failed"
                                ? "bg-red-500"
                                : "bg-zinc-400",
                    ].join(" ")}
                  />
                  <p className="font-medium">{deployment.name}</p>
                  {deployment.isPrimary && (
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
                <p className="font-mono text-xs text-muted-foreground">{deployment.ingressHost}</p>
                <p className="font-mono text-xs text-muted-foreground">{deployment.id}</p>
              </div>

              <div className="flex shrink-0 flex-wrap gap-2">
                <Button asChild size="sm" variant="outline">
                  <Link
                    to="/jonasland/$projectSlug/deployments/$deploymentId"
                    params={{
                      projectSlug: params.projectSlug,
                      deploymentId: deployment.id,
                    }}
                  >
                    <ExternalLink className="h-4 w-4" />
                    Details
                  </Link>
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={deployment.isPrimary}
                  onClick={() => makePrimary.mutate(deployment.id)}
                >
                  Make primary
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
