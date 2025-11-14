import { useState, Suspense } from "react";
import { Save, Info } from "lucide-react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { createFileRoute, getRouteApi } from "@tanstack/react-router";
import { Spinner } from "../../components/ui/spinner.tsx";
import { useTRPC } from "../../lib/trpc.ts";
import { Button } from "../../components/ui/button.tsx";
import { Input } from "../../components/ui/input.tsx";
import { Card, CardContent } from "../../components/ui/card.tsx";
import { Alert, AlertDescription } from "../../components/ui/alert.tsx";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "../../components/ui/field.tsx";

const orgLayoutRoute = getRouteApi("/_auth.layout/$organizationId");

function OrganizationSettingsContent({ organizationId }: { organizationId: string }) {
  const trpc = useTRPC();
  const loaderData = orgLayoutRoute.useLoaderData();
  const { data: organization } = useQuery(
    trpc.organization.get.queryOptions(
      { organizationId },
      {
        initialData: loaderData?.organization,
      },
    ),
  );

  const queryClient = useQueryClient();
  const [organizationName, setOrganizationName] = useState(organization?.name ?? "");

  const updateOrganization = useMutation(
    trpc.organization.updateName.mutationOptions({
      onSuccess: (data) => {
        toast.success("Organization name updated successfully");
        queryClient.invalidateQueries({
          queryKey: [
            trpc.organization.get.queryKey({ organizationId }),
            trpc.organization.list.queryKey(),
          ],
        });
        setOrganizationName(data.name);
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

    if (organizationName === organization?.name) {
      toast.error("No changes to save");
      return;
    }

    updateOrganization.mutate({
      organizationId,
      name: organizationName,
    });
  };

  const hasChanges = organizationName !== organization?.name;

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 max-w-5xl">
      <Card variant="muted">
        <CardContent>
          <form onSubmit={handleSubmit}>
            <FieldSet>
              <FieldLegend>Organization Settings</FieldLegend>
              <FieldDescription>
                Manage your organization configuration and preferences
              </FieldDescription>
              <FieldGroup>
                <Field>
                  <FieldLabel htmlFor="organizationName">Organization Name</FieldLabel>
                  <Input
                    id="organizationName"
                    type="text"
                    placeholder="My Company"
                    value={organizationName}
                    onChange={(e) => {
                      setOrganizationName(e.target.value);
                    }}
                    disabled={updateOrganization.isPending}
                  />
                </Field>

                <Button type="submit" disabled={updateOrganization.isPending || !hasChanges}>
                  {updateOrganization.isPending ? (
                    <>
                      <Spinner className="mr-2 h-4 w-4" />
                      Saving...
                    </>
                  ) : (
                    <>
                      <Save className="mr-2 h-4 w-4" />
                      Save Changes
                    </>
                  )}
                </Button>
              </FieldGroup>
            </FieldSet>
          </form>
        </CardContent>
      </Card>

      <Alert className="self-start">
        <Info className="h-4 w-4" />
        <AlertDescription className="text-pretty">
          The primary way to configure iterate is via the{" "}
          <code className="text-sm">iterate.config.ts</code> file in your repository. This follows
          the principles of{" "}
          <a
            href="https://en.wikipedia.org/wiki/Infrastructure_as_code"
            target="_blank"
            rel="noopener noreferrer"
            className="underline hover:text-foreground"
          >
            infrastructure as code.
          </a>{" "}
          Or, in this case perhaps "startup as code".
        </AlertDescription>
      </Alert>
    </div>
  );
}

export const Route = createFileRoute("/_auth.layout/$organizationId/settings")({
  component: OrganizationSettings,
  head: () => ({
    meta: [
      {
        title: "Organization Settings - Iterate",
      },
      {
        name: "description",
        content: "Manage your organization settings",
      },
    ],
  }),
});

function OrganizationSettings() {
  const { organizationId } = Route.useParams();

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
        <div className="flex items-center justify-center py-16">
          <Spinner className="h-8 w-8" />
        </div>
      }
    >
      <OrganizationSettingsContent organizationId={organizationId} />
    </Suspense>
  );
}
