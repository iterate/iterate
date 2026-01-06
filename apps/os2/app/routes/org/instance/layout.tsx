import * as React from "react";
import { createFileRoute, Outlet, useParams } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { trpc } from "../../../lib/trpc.ts";

export const Route = createFileRoute("/_auth-required.layout/_/$organizationSlug/_/$instanceSlug")({
  component: InstanceLayout,
});

function InstanceLayout() {
  const params = useParams({ from: "/_auth-required.layout/_/$organizationSlug/_/$instanceSlug" });

  const { data: instance, isLoading } = useQuery(
    trpc.instance.bySlug.queryOptions({
      organizationSlug: params.organizationSlug,
      instanceSlug: params.instanceSlug,
    }),
  );

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-muted-foreground">Loading...</div>
      </div>
    );
  }

  if (!instance) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-muted-foreground">Instance not found</div>
      </div>
    );
  }

  return <Outlet />;
}
