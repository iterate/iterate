import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Button } from "../components/ui/button.tsx";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../components/ui/card.tsx";
import { Input } from "../components/ui/input.tsx";
import { useTRPC } from "../lib/trpc.ts";

export const Route = createFileRoute("/_auth.layout/new-organization")({
  component: NewOrganizationPage,
});

function NewOrganizationPage() {
  const [name, setName] = useState("");
  const navigate = useNavigate();
  const trpc = useTRPC();

  const createOrg = useMutation(trpc.organization.create.mutationOptions());

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const org = await createOrg.mutateAsync({ name });
    navigate({ to: "/$organizationSlug", params: { organizationSlug: org.slug } });
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-background">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <CardTitle className="text-2xl">Create Organization</CardTitle>
          <CardDescription>Create your first organization to get started</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <Input
                placeholder="Organization name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
              />
            </div>
            <Button type="submit" className="w-full" disabled={createOrg.isPending}>
              {createOrg.isPending ? "Creating..." : "Create Organization"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
