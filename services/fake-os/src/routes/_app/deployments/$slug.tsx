import { createFileRoute, Outlet, useNavigate } from "@tanstack/react-router";
import { useSuspenseQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Suspense } from "react";
import { Loader2Icon, TrashIcon } from "lucide-react";
import { Button } from "@iterate-com/ui/components/button";
import { Identifier } from "@iterate-com/ui/components/identifier";
import { orpc } from "@/lib/orpc.ts";

export const Route = createFileRoute("/_app/deployments/$slug")({
  component: DeploymentLayout,
});

function DeploymentLayout() {
  return (
    <Suspense
      fallback={
        <div className="flex items-center justify-center h-32">
          <Loader2Icon className="size-6 animate-spin text-muted-foreground" />
        </div>
      }
    >
      <DeploymentLayoutInner />
    </Suspense>
  );
}

function DeploymentLayoutInner() {
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
    <div className="flex flex-col overflow-hidden -m-4" style={{ height: "calc(100% + 2rem)" }}>
      <div className="shrink-0 flex items-center justify-between border-b px-4 py-2">
        <Identifier value={deployment.slug} textClassName="text-base font-semibold" />
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

      <div className="min-h-0 flex-1 overflow-hidden">
        <Outlet />
      </div>
    </div>
  );
}
