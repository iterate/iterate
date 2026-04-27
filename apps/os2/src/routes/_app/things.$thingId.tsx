import { Link, createFileRoute } from "@tanstack/react-router";
import { Button } from "@iterate-com/ui/components/button";
import { Identifier } from "@iterate-com/ui/components/identifier";
import { orpc } from "~/orpc/client.ts";

export const Route = createFileRoute("/_app/things/$thingId")({
  loader: async ({ context, params }) => {
    const thing = await context.queryClient.ensureQueryData({
      ...orpc.things.find.queryOptions({ input: { id: params.thingId } }),
      staleTime: 30_000,
    });

    return {
      breadcrumb: thing.thing,
      thing,
    };
  },
  component: ThingDetailPage,
});

function ThingDetailPage() {
  const { thing } = Route.useLoaderData();

  return (
    <section className="space-y-4 p-4">
      <div className="space-y-1">
        <h2 className="text-sm font-semibold">{thing.thing}</h2>
        <p className="text-sm text-muted-foreground">
          Detail page for the nested breadcrumb os. The second crumb comes from the route loader,
          not from pathname parsing.
        </p>
      </div>

      <div className="space-y-3 rounded-lg border bg-card p-4">
        <div className="space-y-1">
          <p className="text-xs uppercase tracking-wide text-muted-foreground">Thing</p>
          <p className="font-medium">{thing.thing}</p>
        </div>

        <div className="space-y-1">
          <p className="text-xs uppercase tracking-wide text-muted-foreground">Identifier</p>
          <Identifier value={thing.id} />
        </div>

        <div className="space-y-1">
          <p className="text-xs uppercase tracking-wide text-muted-foreground">Created</p>
          <p className="text-sm text-muted-foreground">{thing.createdAt}</p>
        </div>

        <div className="space-y-1">
          <p className="text-xs uppercase tracking-wide text-muted-foreground">Updated</p>
          <p className="text-sm text-muted-foreground">{thing.updatedAt}</p>
        </div>
      </div>

      <Button size="sm" variant="outline" nativeButton={false} render={<Link to="/things" />}>
        Back to things
      </Button>
    </section>
  );
}
