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
  const navigate = useNavigate();
  const trpc = useTRPC();
  const [name, setName] = useState("");

  const createOrg = useMutation(
    trpc.organization.create.mutationOptions({
      onSuccess: (org) => {
        navigate({ to: "/$organizationSlug", params: { organizationSlug: org.slug } });
      },
    }),
  );

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (name.trim()) {
      createOrg.mutate({ name: name.trim() });
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <CardTitle className="text-2xl">Create Organization</CardTitle>
          <CardDescription>Create a new organization to get started</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            <Input
              placeholder="Organization name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
            />
            <Button type="submit" className="w-full" disabled={createOrg.isPending}>
              {createOrg.isPending ? "Creating..." : "Create Organization"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
