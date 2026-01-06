import { useState, type FormEvent } from "react";
import { createFileRoute, useParams } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { trpc, trpcClient } from "../../lib/trpc.ts";
import { Button } from "../../components/ui/button.tsx";
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
    <OrgSettingsForm
      key={org.id}
      organization={{ id: org.id, name: org.name, slug: org.slug }}
      isSaving={updateOrg.isPending}
      onSubmit={(name) => updateOrg.mutate(name)}
    />
  );
}

type OrgSettingsFormProps = {
  organization: {
    id: string;
    name: string;
    slug: string;
  };
  isSaving: boolean;
  onSubmit: (name: string) => void;
};

function OrgSettingsForm({ organization, isSaving, onSubmit }: OrgSettingsFormProps) {
  const [name, setName] = useState(organization.name);

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (name.trim() && name !== organization.name) {
      onSubmit(name.trim());
    }
  };

  return (
    <div className="p-8 max-w-2xl space-y-6">
      <h1 className="text-2xl font-bold">Organization</h1>
      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="space-y-2">
          <label className="text-sm font-medium" htmlFor="organization-name">
            Name
          </label>
          <Input
            id="organization-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={isSaving}
          />
        </div>
        <div className="space-y-2">
          <label className="text-sm font-medium text-muted-foreground" htmlFor="organization-slug">
            Slug
          </label>
          <Input id="organization-slug" value={organization.slug} disabled />
        </div>
        <Button type="submit" disabled={!name.trim() || name === organization.name || isSaving}>
          {isSaving ? "Saving..." : "Save"}
        </Button>
      </form>
    </div>
  );
}
