import { useState } from "react";
import { createServerFn, getGlobalStartContext } from "@tanstack/react-start";
import { Link, createFileRoute } from "@tanstack/react-router";
import { useMutation } from "@tanstack/react-query";
import { Building2 } from "lucide-react";
import { Button } from "@iterate-com/ui/components/button";
import { Field, FieldError, FieldGroup, FieldLabel } from "@iterate-com/ui/components/field";
import { Input } from "@iterate-com/ui/components/input";
import { toast } from "@iterate-com/ui/components/sonner";
import { z } from "zod";
import { createAuthWorkerServiceClient } from "~/auth/auth-worker-service.ts";
import { useAuthClient } from "~/auth/client.tsx";
import { requireSignedInForOrganizationRoute } from "~/lib/auth.ts";

export const Route = createFileRoute("/organization")({
  loader: () => requireSignedInForOrganizationRoute(),
  component: OrganizationRoute,
});

const CreateOrganizationInput = z.object({
  name: z.string().trim().min(1, "Organization name is required").max(100),
});

const createOrganizationForCurrentUser = createServerFn({ method: "POST" })
  .inputValidator(CreateOrganizationInput)
  .handler(async ({ data }) => {
    const context = getGlobalStartContext();
    if (!context) {
      throw new Error("No request context found.");
    }

    const principal = context?.principal;
    if (principal?.type !== "user") {
      throw new Error("You must be signed in to create an organization.");
    }

    const authWorker = createAuthWorkerServiceClient(context);
    return await authWorker.internal.organization.createForUser({
      name: data.name,
      userId: principal.userId,
    });
  });

function OrganizationRoute() {
  const [organizationName, setOrganizationName] = useState("");
  const { session, loading, signIn } = useAuthClient();
  const organizations = session?.authenticated ? session.session.organizations : [];
  const createOrganization = useMutation({
    mutationFn: (input: z.input<typeof CreateOrganizationInput>) =>
      createOrganizationForCurrentUser({ data: input }),
    onSuccess: () => {
      window.location.href = "/api/iterate-auth/login";
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "Failed to create organization");
    },
  });
  const parsedOrganization = CreateOrganizationInput.safeParse({ name: organizationName });

  return (
    <main className="grid min-h-svh place-items-center bg-background p-4">
      <div className="w-full max-w-sm space-y-4">
        {organizations.map((organization) => (
          <Button
            key={organization.id}
            variant="outline"
            className="h-11 w-full justify-start gap-2"
            render={
              <Link to="/org/$organizationSlug" params={{ organizationSlug: organization.slug }} />
            }
          >
            <Building2 className="size-4" />
            <span className="truncate">{organization.name}</span>
          </Button>
        ))}
        {!loading && organizations.length === 0 ? (
          <>
            <div className="space-y-1">
              <h1 className="text-lg font-semibold">Create an organization</h1>
              <p className="text-sm text-muted-foreground">
                Organizations own projects and MCP access.
              </p>
            </div>
            <form
              className="space-y-4"
              onSubmit={(event) => {
                event.preventDefault();
                const parsed = CreateOrganizationInput.safeParse({ name: organizationName });
                if (!parsed.success) return;
                createOrganization.mutate(parsed.data);
              }}
            >
              <FieldGroup>
                <Field data-invalid={!parsedOrganization.success && organizationName.length > 0}>
                  <FieldLabel htmlFor="organization-name">Name</FieldLabel>
                  <Input
                    id="organization-name"
                    name="organization-name"
                    placeholder="Acme"
                    value={organizationName}
                    onChange={(event) => setOrganizationName(event.target.value)}
                    aria-invalid={!parsedOrganization.success && organizationName.length > 0}
                  />
                  {!parsedOrganization.success && organizationName.length > 0 ? (
                    <FieldError errors={parsedOrganization.error.issues} />
                  ) : null}
                </Field>
              </FieldGroup>
              <div className="flex gap-2">
                <Button
                  type="submit"
                  disabled={!parsedOrganization.success || createOrganization.isPending}
                >
                  {createOrganization.isPending ? "Creating..." : "Create"}
                </Button>
                <Button type="button" variant="outline" onClick={signIn}>
                  Continue
                </Button>
              </div>
            </form>
          </>
        ) : null}
      </div>
    </main>
  );
}
