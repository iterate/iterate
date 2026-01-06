import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/_auth.layout/$organizationSlug/")({
  beforeLoad: async ({ context, params }) => {
    const instances = await context.trpcClient.instance.list.query({
      organizationSlug: params.organizationSlug,
    });

    if (instances.length > 0) {
      throw redirect({
        to: "/$organizationSlug/$instanceSlug",
        params: {
          organizationSlug: params.organizationSlug,
          instanceSlug: instances[0].slug,
        },
      });
    }
  },
  component: OrgIndex,
});

function OrgIndex() {
  return (
    <div className="flex flex-col items-center justify-center h-full">
      <h1 className="text-2xl font-bold mb-4">No Instances</h1>
      <p className="text-muted-foreground mb-4">Create your first instance to get started.</p>
    </div>
  );
}
