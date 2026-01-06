import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useSuspenseQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useTRPC } from "../../lib/trpc.ts";
import { Button } from "../../components/ui/button.tsx";
import { Input } from "../../components/ui/input.tsx";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../../components/ui/card.tsx";

export const Route = createFileRoute("/_auth.layout/$organizationSlug/settings")({
  component: SettingsPage,
});

function SettingsPage() {
  const { organizationSlug } = Route.useParams();
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  const { data: organization } = useSuspenseQuery(
    trpc.organization.get.queryOptions({ organizationSlug }),
  );

  const [name, setName] = useState(organization.name);

  const updateOrg = useMutation(trpc.organization.update.mutationOptions());

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    await updateOrg.mutateAsync({ organizationSlug, name });
    queryClient.invalidateQueries();
    toast.success("Organization updated");
  };

  return (
    <div className="max-w-2xl">
      <h1 className="text-2xl font-bold mb-6">Organization Settings</h1>

      <Card>
        <CardHeader>
          <CardTitle>General</CardTitle>
          <CardDescription>Update your organization details</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="text-sm font-medium">Name</label>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Organization name"
              />
            </div>
            <Button type="submit" disabled={updateOrg.isPending}>
              {updateOrg.isPending ? "Saving..." : "Save Changes"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
