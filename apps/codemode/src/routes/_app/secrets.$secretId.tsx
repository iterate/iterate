import { Link, createFileRoute } from "@tanstack/react-router";
import { Button } from "@iterate-com/ui/components/button";
import { Identifier } from "@iterate-com/ui/components/identifier";
import { orpc } from "~/orpc/client.ts";

export const Route = createFileRoute("/_app/secrets/$secretId")({
  loader: async ({ context, params }) => {
    const secret = await context.queryClient.ensureQueryData({
      ...orpc.secrets.find.queryOptions({ input: { id: params.secretId } }),
      staleTime: 30_000,
    });

    return {
      breadcrumb: secret.key,
      secret,
    };
  },
  component: SecretDetailPage,
});

function SecretDetailPage() {
  const { secret } = Route.useLoaderData();

  return (
    <section className="max-w-md space-y-4 p-4">
      <div className="space-y-1">
        <p className="text-sm font-semibold">{secret.key}</p>
        <p className="text-sm text-muted-foreground">Secret detail.</p>
      </div>

      <div className="space-y-4 rounded-lg border p-4">
        <div className="space-y-1">
          <p className="text-xs text-muted-foreground">Value</p>
          <p className="font-mono text-sm break-all">{secret.value}</p>
        </div>

        {secret.description ? (
          <div className="space-y-1">
            <p className="text-xs text-muted-foreground">Description</p>
            <p className="text-sm">{secret.description}</p>
          </div>
        ) : null}

        <div className="space-y-1">
          <p className="text-xs text-muted-foreground">Identifier</p>
          <Identifier value={secret.id} />
        </div>

        <div className="space-y-1">
          <p className="text-xs text-muted-foreground">Created</p>
          <p className="text-sm text-muted-foreground">{secret.createdAt}</p>
        </div>

        <div className="space-y-1">
          <p className="text-xs text-muted-foreground">Updated</p>
          <p className="text-sm text-muted-foreground">{secret.updatedAt}</p>
        </div>
      </div>

      <Button size="sm" variant="outline" nativeButton={false} render={<Link to="/secrets" />}>
        Back to secrets
      </Button>
    </section>
  );
}
