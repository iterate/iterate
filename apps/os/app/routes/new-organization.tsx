import { useState, type FormEvent } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "../components/ui/button.tsx";
import { CenteredLayout } from "../components/centered-layout.tsx";
import { Field, FieldGroup, FieldLabel, FieldSet } from "../components/ui/field.tsx";
import { Input } from "../components/ui/input.tsx";
import { trpcClient, trpc } from "../lib/trpc.tsx";

export const Route = createFileRoute("/_auth/new-organization")({
  component: NewOrganizationPage,
  loader: async () => {
    const user = await trpcClient.user.me.query();
    const defaultName = user.email.split("@").at(-1) ?? "";
    return { defaultName };
  },
});

type Organization = {
  id: string;
  name: string;
  slug: string;
  role?: string;
  instances?: unknown[];
};

function NewOrganizationPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { defaultName } = Route.useLoaderData();
  const [name, setName] = useState(defaultName);

  const createOrg = useMutation({
    mutationFn: async (name: string) => {
      return trpcClient.organization.create.mutate({ name });
    },
    onSuccess: (org) => {
      queryClient.setQueryData<Organization[]>(trpc.user.myOrganizations.queryKey(), (old) => [
        ...(old || []),
        { ...org, role: "owner", instances: [] },
      ]);
      toast.success("Organization created!");
      navigate({ to: "/orgs/$organizationSlug", params: { organizationSlug: org.slug } });
    },
    onError: (error) => {
      toast.error("Failed to create organization: " + error.message);
    },
  });

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (name.trim()) {
      createOrg.mutate(name.trim());
    }
  };

  return (
    <CenteredLayout>
      <div className="w-full max-w-md space-y-6">
        <h1 className="text-2xl font-semibold">Create organization</h1>
        <form onSubmit={handleSubmit}>
          <FieldGroup>
            <FieldSet>
              <Field>
                <FieldLabel htmlFor="organization-name">Organization name</FieldLabel>
                <Input
                  id="organization-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  disabled={createOrg.isPending}
                  autoFocus
                />
              </Field>
            </FieldSet>
            <Field orientation="horizontal">
              <Button
                type="submit"
                className="w-full"
                disabled={!name.trim() || createOrg.isPending}
              >
                {createOrg.isPending ? "Creating..." : "Create organization"}
              </Button>
            </Field>
          </FieldGroup>
        </form>
      </div>
    </CenteredLayout>
  );
}
