import { useState, Suspense } from "react";
import { Loader2, Save } from "lucide-react";
import { useSuspenseQuery, useMutation } from "@tanstack/react-query";
import { useTRPC } from "../../lib/trpc.ts";
import { Button } from "../../components/ui/button.tsx";
import { Input } from "../../components/ui/input.tsx";
import { Label } from "../../components/ui/label.tsx";
import { Card, CardContent } from "../../components/ui/card.tsx";
import type { Route } from "./+types/settings.ts";

export function meta(_args: Route.MetaArgs) {
  return [
    { title: "Organization Settings - Iterate" },
    { name: "description", content: "Manage your organization settings" },
  ];
}

function OrganizationSettingsContent({ organizationId }: { organizationId: string }) {
  const trpc = useTRPC();
  const { data: organization } = useSuspenseQuery(
    trpc.organization.get.queryOptions({ organizationId }),
  );

  const [organizationName, setOrganizationName] = useState(organization.name);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  const updateOrganization = useMutation(
    trpc.organization.updateName.mutationOptions({
      onSuccess: (data) => {
        setSuccessMessage("Organization name updated successfully");
        setOrganizationName(data.name);
        setError(null);

        // Clear success message after 3 seconds
        setTimeout(() => setSuccessMessage(null), 3000);
      },
      onError: (error) => {
        setError(error.message);
        setSuccessMessage(null);
      },
    }),
  );

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSuccessMessage(null);

    if (!organizationName.trim()) {
      setError("Organization name is required");
      return;
    }

    if (organizationName === organization.name) {
      setError("No changes to save");
      return;
    }

    updateOrganization.mutate({
      organizationId,
      name: organizationName,
    });
  };

  const hasChanges = organizationName !== organization.name;

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-3xl font-bold mb-2">Organization Settings</h1>
        <p className="text-muted-foreground text-lg">
          Manage your organization configuration and preferences
        </p>
      </div>

      <Card variant="muted">
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="organizationName">Organization Name</Label>
              <Input
                id="organizationName"
                type="text"
                placeholder="My Company"
                value={organizationName}
                onChange={(e) => {
                  setOrganizationName(e.target.value);
                  setError(null);
                  setSuccessMessage(null);
                }}
                disabled={updateOrganization.isPending}
              />
            </div>

            {error && (
              <div className="text-sm text-destructive bg-destructive/10 p-3 rounded-md">
                {error}
              </div>
            )}

            {successMessage && (
              <div className="text-sm p-3 rounded-md border bg-card">{successMessage}</div>
            )}

            <Button type="submit" disabled={updateOrganization.isPending || !hasChanges}>
              {updateOrganization.isPending ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Saving...
                </>
              ) : (
                <>
                  <Save className="mr-2 h-4 w-4" />
                  Save Changes
                </>
              )}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}

export default function OrganizationSettings({ params }: Route.ComponentProps) {
  const { organizationId } = params;

  if (!organizationId) {
    return (
      <div className="p-6">
        <div className="text-center text-destructive">Organization ID is required</div>
      </div>
    );
  }

  return (
    <Suspense
      fallback={
        <div className="p-6">
          <div className="flex items-center justify-center h-64">
            <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
          </div>
        </div>
      }
    >
      <OrganizationSettingsContent organizationId={organizationId} />
    </Suspense>
  );
}
