import { useState, type FormEvent } from "react";
import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { useSuspenseQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Building2, Check, X } from "lucide-react";
import { authMiddleware } from "../lib/auth-middleware.ts";
import { trpc, trpcClient } from "../lib/trpc.tsx";
import { Button } from "../components/ui/button.tsx";
import { CenteredLayout } from "../components/centered-layout.tsx";
import { Field, FieldGroup, FieldLabel, FieldSet } from "../components/ui/field.tsx";
import { Input } from "../components/ui/input.tsx";
import {
  Item,
  ItemContent,
  ItemGroup,
  ItemMedia,
  ItemSeparator,
  ItemTitle,
  ItemDescription,
  ItemActions,
} from "../components/ui/item.tsx";

const getDefaultOrgName = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const user = await context.variables.trpcCaller.user.me();
    return user.email.split("@").at(-1) ?? "";
  });

const maybeRedirectToOrg = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const organizations = await context.variables.trpcCaller.user.myOrganizations();

    // If user has orgs, redirect to their project/org
    if (organizations && organizations.length > 0) {
      const orgWithProjects = organizations.find(
        (organization) => (organization.projects || []).length > 0,
      );

      if (orgWithProjects) {
        const firstProject = orgWithProjects.projects?.[0];
        if (firstProject) {
          throw redirect({
            to: "/orgs/$organizationSlug/projects/$projectSlug",
            params: {
              organizationSlug: orgWithProjects.slug,
              projectSlug: firstProject.slug,
            },
          });
        }
      }

      throw redirect({
        to: "/orgs/$organizationSlug/new-project",
        params: { organizationSlug: organizations[0].slug },
      });
    }
  });

export const Route = createFileRoute("/_auth/")({
  beforeLoad: () => maybeRedirectToOrg(),
  loader: () => getDefaultOrgName(),
  component: IndexPage,
});

type Organization = {
  id: string;
  name: string;
  slug: string;
  role?: string;
  instances?: unknown[];
};

function IndexPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const defaultOrgName = Route.useLoaderData();
  const [name, setName] = useState(defaultOrgName);

  const { data: pendingInvites } = useSuspenseQuery(
    trpc.organization.myPendingInvites.queryOptions(),
  );

  const acceptInvite = useMutation({
    mutationFn: async (inviteId: string) => {
      return trpcClient.organization.acceptInvite.mutate({ inviteId });
    },
    onSuccess: (org) => {
      toast.success(`Joined ${org.name}!`);
      navigate({ to: "/orgs/$organizationSlug", params: { organizationSlug: org.slug } });
    },
    onError: (error: Error) => {
      toast.error(error.message);
    },
  });

  const declineInvite = useMutation({
    mutationFn: async (inviteId: string) => {
      return trpcClient.organization.declineInvite.mutate({ inviteId });
    },
    onSuccess: () => {
      toast.success("Invite declined");
    },
    onError: (error: Error) => {
      toast.error(error.message);
    },
  });

  const createOrg = useMutation({
    mutationFn: async (orgName: string) => {
      return trpcClient.organization.create.mutate({ name: orgName });
    },
    onSuccess: (org) => {
      queryClient.setQueryData<Organization[]>(trpc.user.myOrganizations.queryKey(), (old) => [
        ...(old || []),
        { ...org, role: "owner", instances: [] },
      ]);
      toast.success("Organization created!");
      navigate({ to: "/orgs/$organizationSlug", params: { organizationSlug: org.slug } });
    },
    onError: (error: Error) => {
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
    <CenteredLayout>
      <div className="w-full max-w-md space-y-6">
        <h1 className="text-2xl font-semibold">Welcome to Iterate</h1>

        {pendingInvites.length > 0 && (
          <div className="space-y-3">
            <p className="text-muted-foreground">You&apos;ve been invited to join:</p>
            <ItemGroup className="rounded-lg border">
              {pendingInvites.map((invite, index) => (
                <div key={invite.id}>
                  {index > 0 && <ItemSeparator />}
                  <Item variant="default">
                    <ItemMedia variant="icon">
                      <Building2 className="h-4 w-4" />
                    </ItemMedia>
                    <ItemContent>
                      <ItemTitle>{invite.organization.name}</ItemTitle>
                      <ItemDescription>
                        Invited by {invite.invitedBy.name} as {invite.role}
                      </ItemDescription>
                    </ItemContent>
                    <ItemActions>
                      <Button
                        size="sm"
                        onClick={() => acceptInvite.mutate(invite.id)}
                        disabled={acceptInvite.isPending || declineInvite.isPending}
                      >
                        <Check className="h-4 w-4" />
                        Accept
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => declineInvite.mutate(invite.id)}
                        disabled={acceptInvite.isPending || declineInvite.isPending}
                      >
                        <X className="h-4 w-4" />
                      </Button>
                    </ItemActions>
                  </Item>
                </div>
              ))}
            </ItemGroup>
          </div>
        )}

        <div className={pendingInvites.length > 0 ? "pt-4 border-t" : ""}>
          {pendingInvites.length > 0 && (
            <p className="text-sm text-muted-foreground mb-3">Or create your own organization:</p>
          )}
          <form onSubmit={handleSubmit}>
            <FieldGroup>
              <FieldSet>
                <Field>
                  <FieldLabel htmlFor="organization-name">Organization name</FieldLabel>
                  <Input
                    id="organization-name"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    disabled={createOrg.isPending}
                    autoFocus={pendingInvites.length === 0}
                  />
                </Field>
              </FieldSet>
              <Field orientation="horizontal">
                <Button
                  type="submit"
                  className="w-full"
                  disabled={!name.trim() || createOrg.isPending}
                >
                  {createOrg.isPending ? "Creating..." : "Create organization"}
                </Button>
              </Field>
            </FieldGroup>
          </form>
        </div>
      </div>
    </CenteredLayout>
  );
}
