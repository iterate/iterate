import { createFileRoute, Link, useParams } from "@tanstack/react-router";
import { useSuspenseQuery, useMutation } from "@tanstack/react-query";
import { Box, Plus, UserPlus, Mail, X, User } from "lucide-react";
import { toast } from "sonner";
import { trpc, trpcClient } from "../../lib/trpc.tsx";
import { Button } from "../../components/ui/button.tsx";
import { EmptyState } from "../../components/empty-state.tsx";
import { HeaderActions } from "../../components/header-actions.tsx";
import { Avatar, AvatarFallback, AvatarImage } from "../../components/ui/avatar.tsx";
import {
  Item,
  ItemContent,
  ItemGroup,
  ItemMedia,
  ItemSeparator,
  ItemTitle,
  ItemDescription,
  ItemActions,
} from "../../components/ui/item.tsx";

export const Route = createFileRoute("/_auth/orgs/$organizationSlug/")({
  component: OrgHomePage,
});

function OrgHomePage() {
  const params = useParams({ from: "/_auth/orgs/$organizationSlug/" });

  const { data: org } = useSuspenseQuery(
    trpc.organization.withProjects.queryOptions({
      input: { organizationSlug: params.organizationSlug },
    }),
  );

  const { data: pendingInvites } = useSuspenseQuery(
    trpc.organization.listInvites.queryOptions({
      input: { organizationSlug: params.organizationSlug },
    }),
  );

  const { data: members } = useSuspenseQuery(
    trpc.organization.members.queryOptions({
      input: { organizationSlug: params.organizationSlug },
    }),
  );

  const createInvite = useMutation({
    mutationFn: async (email: string) => {
      return trpcClient.organization.createInvite({
        organizationSlug: params.organizationSlug,
        email,
      });
    },
    onSuccess: () => {
      toast.success("Invite sent");
    },
    onError: (error: Error) => {
      toast.error(error.message);
    },
  });

  const cancelInvite = useMutation({
    mutationFn: async (inviteId: string) => {
      return trpcClient.organization.cancelInvite({
        organizationSlug: params.organizationSlug,
        inviteId,
      });
    },
    onSuccess: () => {
      toast.success("Invite cancelled");
    },
    onError: (error: Error) => {
      toast.error(error.message);
    },
  });

  const projects = org?.projects ?? [];
  const isAdmin = org?.role === "admin" || org?.role === "owner";

  const handleInviteMember = () => {
    const email = prompt("Enter email address to invite:");
    if (!email) return;

    createInvite.mutate(email);
  };

  return (
    <div className="p-4 space-y-6">
      <HeaderActions>
        <Button asChild size="sm">
          <Link
            to="/orgs/$organizationSlug/new-project"
            params={{ organizationSlug: params.organizationSlug }}
          >
            <Plus className="h-4 w-4" />
            <span className="sr-only">New project</span>
          </Link>
        </Button>
      </HeaderActions>

      {projects.length === 0 ? (
        <EmptyState
          icon={<Box className="h-12 w-12" />}
          title="No projects yet"
          description="Create your first project to get started."
          action={
            <Button asChild>
              <Link
                to="/orgs/$organizationSlug/new-project"
                params={{ organizationSlug: params.organizationSlug }}
              >
                <Plus className="h-4 w-4" />
                Create project
              </Link>
            </Button>
          }
        />
      ) : (
        <ItemGroup className="rounded-lg border">
          {projects.map((project, index) => (
            <div key={project.id}>
              {index > 0 && <ItemSeparator />}
              <Item asChild variant="default" className="hover:bg-accent/50 cursor-pointer">
                <Link
                  to="/orgs/$organizationSlug/projects/$projectSlug"
                  params={{
                    organizationSlug: params.organizationSlug,
                    projectSlug: project.slug,
                  }}
                >
                  <ItemMedia variant="icon">
                    <Box className="h-4 w-4" />
                  </ItemMedia>
                  <ItemContent>
                    <ItemTitle>{project.name}</ItemTitle>
                  </ItemContent>
                </Link>
              </Item>
            </div>
          ))}
        </ItemGroup>
      )}

      {/* Team Section */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-medium text-muted-foreground">Team</h2>
          {isAdmin && (
            <Button variant="outline" size="sm" onClick={handleInviteMember}>
              <UserPlus className="h-4 w-4" />
              Invite member
            </Button>
          )}
        </div>

        <ItemGroup className="rounded-lg border">
          {members.map((member, index) => (
            <div key={member.id}>
              {index > 0 && <ItemSeparator />}
              <Item variant="default">
                <ItemMedia>
                  <Avatar className="h-8 w-8">
                    <AvatarImage src={member.user.image ?? undefined} alt={member.user.name} />
                    <AvatarFallback>
                      <User className="h-4 w-4" />
                    </AvatarFallback>
                  </Avatar>
                </ItemMedia>
                <ItemContent>
                  <ItemTitle>{member.user.name}</ItemTitle>
                  <ItemDescription>
                    {member.user.email} · {member.role}
                  </ItemDescription>
                </ItemContent>
              </Item>
            </div>
          ))}
          {pendingInvites.map((invite) => (
            <div key={invite.id}>
              <ItemSeparator />
              <Item variant="default">
                <ItemMedia variant="icon">
                  <Mail className="h-4 w-4" />
                </ItemMedia>
                <ItemContent>
                  <ItemTitle>{invite.email}</ItemTitle>
                  <ItemDescription>Pending invite · {invite.role}</ItemDescription>
                </ItemContent>
                {isAdmin && (
                  <ItemActions>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => cancelInvite.mutate(invite.id)}
                    >
                      <X className="h-4 w-4" />
                    </Button>
                  </ItemActions>
                )}
              </Item>
            </div>
          ))}
        </ItemGroup>
      </div>
    </div>
  );
}
