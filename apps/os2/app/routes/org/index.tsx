import * as React from "react";
import { createFileRoute, Navigate, useParams } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Box } from "lucide-react";
import { trpc } from "../../lib/trpc.ts";
import { EmptyState } from "../../components/empty-state.tsx";

export const Route = createFileRoute("/_auth-required.layout/_/$organizationSlug/")({
  component: OrgIndexPage,
});

function OrgIndexPage() {
  const params = useParams({ from: "/_auth-required.layout/_/$organizationSlug/" });

  const { data: instances, isLoading } = useQuery(
    trpc.instance.list.queryOptions({
      organizationSlug: params.organizationSlug,
    }),
  );

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-muted-foreground">Loading...</div>
      </div>
    );
  }

  // If there are instances, redirect to the first one
  if (instances && instances.length > 0) {
    return (
      <Navigate
        to="/$organizationSlug/$instanceSlug"
        params={{
          organizationSlug: params.organizationSlug,
          instanceSlug: instances[0].slug,
        }}
      />
    );
  }

  // No instances - show empty state
  return (
    <div className="flex h-full items-center justify-center">
      <EmptyState
        icon={<Box className="h-12 w-12" />}
        title="No instances yet"
        description="Create your first instance to get started."
        action={{
          label: "Create Instance",
          onClick: () => {
            // This would open a dialog or navigate to create instance page
            console.log("Create instance");
          },
        }}
      />
    </div>
  );
}
