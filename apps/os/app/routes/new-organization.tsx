import { useState } from "react";
import { useNavigate } from "react-router";
import { Loader2 } from "lucide-react";
import { useMutation } from "@tanstack/react-query";
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
import type { Route } from "./+types/new-organization";

export function meta(_args: Route.MetaArgs) {
  return [
    { title: "Create Organization - Iterate" },
    { name: "description", content: "Create a new organization" },
  ];
}

export default function NewOrganization() {
  const navigate = useNavigate();
  const trpc = useTRPC();
  const [organizationName, setOrganizationName] = useState("");
  const [error, setError] = useState<string | null>(null);

  const createOrganization = useMutation(
    trpc.organization.create.mutationOptions({
      onSuccess: (data) => {
        // Navigate to the new organization's first estate
        navigate(`/${data.organization.id}/${data.estate.id}`);
      },
      onError: (error) => {
        setError(error.message);
      },
    }),
  );

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!organizationName.trim()) {
      setError("Organization name is required");
      return;
    }

    createOrganization.mutate({ name: organizationName });
  };

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

            {error && <div className="text-sm text-destructive">{error}</div>}

            <Button type="submit" className="w-full" disabled={createOrganization.isPending}>
              {createOrganization.isPending ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
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
