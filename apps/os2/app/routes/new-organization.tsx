import { useState, type FormEvent } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "../components/ui/button.tsx";
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
  const [name, setName] = useState("");

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

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (name.trim()) {
      createOrg.mutate(name.trim());
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center">
      <div className="w-full max-w-md space-y-6">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold">Create organization</h1>
        </div>
        <form onSubmit={handleSubmit} className="space-y-4">
          <Input
            placeholder="Organization name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={createOrg.isPending}
          />
          <Button
            type="submit"
            className="w-full"
            disabled={!name.trim() || createOrg.isPending}
          >
            {createOrg.isPending ? "Creating..." : "Create organization"}
          </Button>
        </form>
      </div>
    </div>
  );
}
