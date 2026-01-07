import { useState, type FormEvent } from "react";
import { createFileRoute, useParams } from "@tanstack/react-router";
import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { trpc, trpcClient } from "../../lib/trpc.tsx";
import { Button } from "../../components/ui/button.tsx";
import {
  Field,
  FieldGroup,
  FieldLabel,
  FieldSet,
} from "../../components/ui/field.tsx";
import { Input } from "../../components/ui/input.tsx";

export const Route = createFileRoute(
  "/_auth-required.layout/_/orgs/$organizationSlug/settings",
)({
  component: OrgSettingsPage,
});

function OrgSettingsPage() {
  const routeParams = useParams({
    from: "/_auth-required.layout/_/orgs/$organizationSlug/settings",
  });
  const queryClient = useQueryClient();

  const { data: org } = useSuspenseQuery(
    trpc.organization.bySlug.queryOptions({
      organizationSlug: routeParams.organizationSlug,
    }),
  );

  const updateOrg = useMutation({
    mutationFn: async (name: string) => {
      return trpcClient.organization.update.mutate({
        organizationSlug: routeParams.organizationSlug,
        name,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: trpc.organization.bySlug.queryKey({
          organizationSlug: routeParams.organizationSlug,
        }),
      });
      queryClient.invalidateQueries({ queryKey: trpc.user.myOrganizations.queryKey() });
      toast.success("Organization updated!");
    },
    onError: (error) => {
      toast.error("Failed to update organization: " + error.message);
    },
  });

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
      <form onSubmit={handleSubmit}>
        <FieldGroup>
          <FieldSet>
            <Field>
              <FieldLabel htmlFor="organization-name">Name</FieldLabel>
              <Input
                id="organization-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                disabled={isSaving}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="organization-slug">Slug</FieldLabel>
              <Input id="organization-slug" value={organization.slug} disabled />
            </Field>
          </FieldSet>
          <Field orientation="horizontal">
            <Button type="submit" disabled={!name.trim() || name === organization.name || isSaving}>
              {isSaving ? "Saving..." : "Save"}
            </Button>
          </Field>
        </FieldGroup>
      </form>
    </div>
  );
}
