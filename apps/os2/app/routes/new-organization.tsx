import * as React from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "../components/ui/button.tsx";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card.tsx";
import { Input } from "../components/ui/input.tsx";
import { trpcClient, trpc } from "../lib/trpc.ts";

export const Route = createFileRoute("/_auth-required.layout/new-organization")({
  component: NewOrganizationPage,
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
  const [name, setName] = React.useState("");

  const createOrg = useMutation({
    mutationFn: async (name: string) => {
      return trpcClient.organization.create.mutate({ name });
    },
    onSuccess: (org) => {
      queryClient.setQueryData<Organization[]>(
        trpc.user.myOrganizations.queryKey(),
        (old) => [...(old || []), { ...org, role: "owner", instances: [] }],
      );
      toast.success("Organization created!");
      navigate({ to: "/$organizationSlug", params: { organizationSlug: org.slug } });
    },
    onError: (error) => {
      toast.error("Failed to create organization: " + error.message);
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (name.trim()) {
      createOrg.mutate(name.trim());
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-muted/50">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>Create Organization</CardTitle>
          <CardDescription>
            Create a new organization to get started with OS2.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <Input
                placeholder="Organization name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                disabled={createOrg.isPending}
              />
            </div>
            <Button
              type="submit"
              className="w-full"
              disabled={!name.trim() || createOrg.isPending}
            >
              {createOrg.isPending ? "Creating..." : "Create Organization"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
