import { useSuspenseQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Users } from "lucide-react";
import { useTRPC } from "../../lib/trpc.ts";
import { Card, CardContent } from "../../components/ui/card.tsx";
import { Button } from "../../components/ui/button.tsx";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from "../../components/ui/item.tsx";
import { Avatar, AvatarFallback, AvatarImage } from "../../components/ui/avatar.tsx";
import { Empty, EmptyDescription, EmptyMedia, EmptyTitle } from "../../components/ui/empty.tsx";
import type { Route } from "./+types/team.ts";

export function meta(_args: Route.MetaArgs) {
  return [
    { title: "Team Members - Iterate" },
    { name: "description", content: "Manage your organization team members" },
  ];
}

const roleLabels: Record<string, string> = {
  owner: "Owner",
  admin: "Admin",
  member: "Member",
  guest: "Guest",
  external: "External",
};

function OrganizationTeamContent({ organizationId }: { organizationId: string }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const { data: currentUser } = useSuspenseQuery(trpc.user.me.queryOptions());
  const { data: members } = useSuspenseQuery(
    trpc.organization.listMembers.queryOptions({ organizationId }),
  );

  const updateRole = useMutation(
    trpc.organization.updateMemberRole.mutationOptions({
      onSuccess: () => {
        toast.success("Member promoted to owner successfully");
        // Invalidate the members query to refetch the data
        queryClient.invalidateQueries({
          queryKey: trpc.organization.listMembers.queryKey({ organizationId }),
        });
      },
      onError: (error) => {
        toast.error(`Failed to promote member: ${error.message}`);
      },
    }),
  );

  const handlePromoteToOwner = (userId: string) => {
    updateRole.mutate({
      organizationId,
      userId,
      role: "owner",
    });
  };

  // Group members by role
  const internalMembers = members.filter((member) => member.role !== "external");
  const externalMembers = members.filter((member) => member.role === "external");

  // Ensure current user is shown first in internal members while preserving other order
  const sortedInternalMembers = sortMembersWithCurrentFirst(internalMembers, currentUser.id);

  const MemberItem = ({ member }: { member: (typeof members)[number] }) => {
    const isCurrentUser = member.userId === currentUser.id;

    return (
      <Item>
        <ItemMedia>
          <Avatar>
            <AvatarImage src={member.image || undefined} />
            <AvatarFallback>{member.name.charAt(0).toUpperCase()}</AvatarFallback>
          </Avatar>
        </ItemMedia>
        <ItemContent className="gap-1 min-w-0">
          <ItemTitle>
            {member.name}
            {isCurrentUser && <span className="ml-2 text-xs text-muted-foreground">(You)</span>}
          </ItemTitle>
          <ItemDescription className="truncate" title={member.email}>
            {member.email}
          </ItemDescription>
        </ItemContent>
        <ItemActions>
          {member.role === "member" && !isCurrentUser ? (
            <Button
              size="sm"
              variant="outline"
              onClick={() => handlePromoteToOwner(member.userId)}
              disabled={updateRole.isPending}
            >
              Make owner
            </Button>
          ) : (
            <span className="text-sm text-muted-foreground px-3 py-1">
              {roleLabels[member.role]}
            </span>
          )}
        </ItemActions>
      </Item>
    );
  };

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
      <Card variant="muted">
        <CardContent>
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold">Organization Members</h2>
            <span className="text-sm text-muted-foreground">
              {internalMembers.length} {internalMembers.length === 1 ? "member" : "members"}
            </span>
          </div>

          <p className="text-sm text-muted-foreground mb-4">
            They are full members of the slack. The @iterate bot will allow them to use MCP servers
            and organization-wide connectors.
          </p>
          <p className="text-sm text-muted-foreground mb-4">
            They are able to access this dashboard.
          </p>

          {sortedInternalMembers.length === 0 ? (
            <Empty>
              <EmptyMedia variant="icon">
                <Users className="h-12 w-12" />
              </EmptyMedia>
              <EmptyTitle>No organization members</EmptyTitle>
              <EmptyDescription>
                Organization members will appear here once they join your team.
              </EmptyDescription>
            </Empty>
          ) : (
            <ItemGroup>
              {sortedInternalMembers.map((member, index) => (
                <div key={member.id}>
                  <MemberItem member={member} />
                  {index !== sortedInternalMembers.length - 1 && <div className="my-2" />}
                </div>
              ))}
            </ItemGroup>
          )}
        </CardContent>
      </Card>

      {/* External Users - Second on mobile, right on desktop */}
      {externalMembers.length > 0 && (
        <Card variant="muted">
          <CardContent>
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-semibold">Slack connect users</h2>
              <span className="text-sm text-muted-foreground">
                {externalMembers.length} {externalMembers.length === 1 ? "user" : "users"}
              </span>
            </div>

            <p className="text-sm text-muted-foreground mb-4">
              The @iterate bot will speak to them like a normal person would.
            </p>
            <p className="text-sm text-muted-foreground mb-4">
              They will not be able to connect to MCP servers, use connectors or access this
              dashboard.
            </p>

            <ItemGroup>
              {externalMembers.map((member, index) => (
                <div key={member.id}>
                  <MemberItem member={member} />
                  {index !== externalMembers.length - 1 && <div className="my-2" />}
                </div>
              ))}
            </ItemGroup>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

export default function OrganizationTeam({ params }: Route.ComponentProps) {
  const { organizationId } = params;

  if (!organizationId) {
    return (
      <div className="p-6">
        <div className="text-center text-destructive">Organization ID is required</div>
      </div>
    );
  }

  return <OrganizationTeamContent organizationId={organizationId} />;
}

function sortMembersWithCurrentFirst<T extends { userId: string }>(
  members: T[],
  currentUserId: string,
): T[] {
  const rolePriority: Record<string, number> = {
    owner: 0,
    admin: 1,
    member: 2,
    guest: 3,
    external: 4,
  };

  return [...members].sort((a: any, b: any) => {
    const aIsCurrent = a.userId === currentUserId;
    const bIsCurrent = b.userId === currentUserId;
    if (aIsCurrent !== bIsCurrent) return aIsCurrent ? -1 : 1;

    const aRolePriority = rolePriority[a.role as string] ?? 99;
    const bRolePriority = rolePriority[b.role as string] ?? 99;
    if (aRolePriority !== bRolePriority) return aRolePriority - bRolePriority;

    return 0;
  });
}
