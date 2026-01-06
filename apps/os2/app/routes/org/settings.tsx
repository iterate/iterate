import * as React from "react";
import { createFileRoute, useParams } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { trpc, trpcClient } from "../../lib/trpc.ts";
import { Button } from "../../components/ui/button.tsx";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../components/ui/card.tsx";
import { Input } from "../../components/ui/input.tsx";

export const Route = createFileRoute("/_auth-required.layout/_/$organizationSlug/settings")({
  component: OrgSettingsPage,
});

function OrgSettingsPage() {
  const params = useParams({ from: "/_auth-required.layout/_/$organizationSlug/settings" });
  const queryClient = useQueryClient();

  const { data: org, isLoading } = useQuery(
    trpc.organization.bySlug.queryOptions({
      organizationSlug: params.organizationSlug,
    }),
  );

  const [name, setName] = React.useState("");

  React.useEffect(() => {
    if (org) {
      setName(org.name);
    }
  }, [org]);

  const updateOrg = useMutation({
    mutationFn: async (name: string) => {
      return trpcClient.organization.update.mutate({
        organizationSlug: params.organizationSlug,
        name,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["organization"] });
      queryClient.invalidateQueries({ queryKey: ["user", "myOrganizations"] });
      toast.success("Organization updated!");
    },
    onError: (error) => {
      toast.error("Failed to update organization: " + error.message);
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (name.trim() && name !== org?.name) {
      updateOrg.mutate(name.trim());
    }
  };

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-muted-foreground">Loading...</div>
      </div>
    );
  }

  if (!org) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-muted-foreground">Organization not found</div>
      </div>
    );
  }

  return (
    <div className="p-8 max-w-2xl">
      <h1 className="text-2xl font-bold mb-6">Organization Settings</h1>

      <Card>
        <CardHeader>
          <CardTitle>General</CardTitle>
          <CardDescription>Update your organization's settings.</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="text-sm font-medium">Organization Name</label>
              <Input
                className="mt-1"
                value={name}
                onChange={(e) => setName(e.target.value)}
                disabled={updateOrg.isPending}
              />
            </div>
            <div>
              <label className="text-sm font-medium text-muted-foreground">Slug</label>
              <Input className="mt-1" value={org.slug} disabled />
              <p className="text-xs text-muted-foreground mt-1">
                The slug cannot be changed.
              </p>
            </div>
            <Button
              type="submit"
              disabled={!name.trim() || name === org.name || updateOrg.isPending}
            >
              {updateOrg.isPending ? "Saving..." : "Save Changes"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
