import { useState } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { Spinner } from "../components/ui/spinner.tsx";
import { useTRPC } from "../lib/trpc.ts";
import { Button } from "../components/ui/button.tsx";
import { Input } from "../components/ui/input.tsx";
import { Label } from "../components/ui/label.tsx";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../components/ui/card.tsx";
import { useSessionUser } from "../hooks/use-session-user.ts";

export const Route = createFileRoute("/_auth.layout/new-organization")({
  component: NewOrganization,
  head: () => ({
    meta: [
      { title: "Create Organization - Iterate" },
      { name: "description", content: "Create a new organization" },
    ],
  }),
});

function NewOrganization() {
  const navigate = useNavigate();
  const trpc = useTRPC();
  const user = useSessionUser();
  const [organizationName, setOrganizationName] = useState("");

  const createOrganization = useMutation(
    trpc.organization.create.mutationOptions({
      onSuccess: (data) => {
        // Navigate to the new organization's first installation
        navigate({ to: `/${data.organization.id}/${data.installation.id}` });
      },
      onError: (error) => {
        toast.error(error.message);
      },
    }),
  );

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();

    if (!organizationName.trim()) {
      toast.error("Organization name is required");
      return;
    }

    createOrganization.mutate({ name: organizationName });
  };

  // Only allow debugMode users to create organizations
  if (!user.debugMode) {
    return (
      <div className="flex min-h-screen items-center justify-center p-4">
        <Card className="w-full max-w-md">
          <CardHeader>
            <CardTitle>Access Denied</CardTitle>
            <CardDescription>
              Organization creation is currently restricted to debug mode users only.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button onClick={() => navigate({ to: "/" })} className="w-full">
              Go Back
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>Create Organization</CardTitle>
          <CardDescription>Create a new organization to get started with iterate</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="organizationName">Organization Name</Label>
              <Input
                id="organizationName"
                type="text"
                placeholder="My Company"
                value={organizationName}
                onChange={(e) => setOrganizationName(e.target.value)}
                disabled={createOrganization.isPending}
                autoFocus
              />
            </div>

            <Button type="submit" className="w-full" disabled={createOrganization.isPending}>
              {createOrganization.isPending ? (
                <>
                  <Spinner className="mr-2 h-4 w-4" />
                  Creating...
                </>
              ) : (
                "Create Organization"
              )}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
