import * as React from "react";
import { createFileRoute, Navigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { trpc } from "../lib/trpc.ts";

export const Route = createFileRoute("/_auth-required.layout/")({
  component: IndexPage,
});

function IndexPage() {

  const { data: organizations, isLoading } = useQuery(
    trpc.user.myOrganizations.queryOptions(),
  );

  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="text-muted-foreground">Loading...</div>
      </div>
    );
  }

  // If user has no organizations, redirect to create one
  if (!organizations || organizations.length === 0) {
    return <Navigate to="/new-organization" />;
  }

  // Redirect to first organization
  const firstOrg = organizations[0];
  return <Navigate to="/$organizationSlug" params={{ organizationSlug: firstOrg.slug }} />;
}
