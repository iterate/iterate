import { createFileRoute } from "@tanstack/react-router";
import { useSuspenseQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Users } from "lucide-react";
import { useTRPC } from "../../lib/trpc.ts";
import { Card, CardContent, CardHeader, CardTitle } from "../../components/ui/card.tsx";
import { Button } from "../../components/ui/button.tsx";
import { Avatar, AvatarFallback, AvatarImage } from "../../components/ui/avatar.tsx";
import { Separator } from "../../components/ui/separator.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../../components/ui/dropdown-menu.tsx";

export const Route = createFileRoute("/_auth.layout/$organizationSlug/team")({
  component: TeamPage,
});

const roleLabels: Record<string, string> = {
  owner: "Owner",
  admin: "Admin",
  member: "Member",
};

function TeamPage() {
  const { organizationSlug } = Route.useParams();
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  const { data: currentUser } = useSuspenseQuery(trpc.user.me.queryOptions());
  const { data: members } = useSuspenseQuery(
    trpc.organization.members.queryOptions({ organizationSlug }),
  );

  const updateRole = useMutation(
    trpc.organization.updateMemberRole.mutationOptions({
      onSuccess: () => {
        toast.success("Member role updated successfully");
        queryClient.invalidateQueries({
          queryKey: trpc.organization.members.queryKey({ organizationSlug }),
        });
      },
      onError: (error) => {
        toast.error(`Failed to update role: ${error.message}`);
      },
    }),
  );

  const removeMember = useMutation(
    trpc.organization.removeMember.mutationOptions({
      onSuccess: () => {
        toast.success("Member removed successfully");
        queryClient.invalidateQueries({
          queryKey: trpc.organization.members.queryKey({ organizationSlug }),
        });
      },
      onError: (error) => {
        toast.error(`Failed to remove member: ${error.message}`);
      },
    }),
  );

  const currentUserMembership = members.find((m) => m.userId === currentUser.id);
  const isAdmin =
    currentUserMembership?.role === "admin" || currentUserMembership?.role === "owner";

  const getInitials = (name: string) => {
    return name
      .split(" ")
      .map((n) => n[0])
      .join("")
      .toUpperCase()
      .slice(0, 2);
  };

  if (members.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-12">
        <Users className="h-12 w-12 text-muted-foreground mb-4" />
        <h2 className="text-xl font-semibold mb-2">No team members</h2>
        <p className="text-muted-foreground">Team members will appear here once they join.</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Team</h1>
        <p className="text-muted-foreground">
          Manage your organization team members and their roles.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center justify-between">
            <span>Members</span>
            <span className="text-sm font-normal text-muted-foreground">
              {members.length} {members.length === 1 ? "member" : "members"}
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-1">
            {members.map((member, index) => {
              const isCurrentUser = member.userId === currentUser.id;
              const canEdit = isAdmin && !isCurrentUser && member.role !== "owner";

              return (
                <div key={member.id}>
                  <div className="flex items-center justify-between py-3">
                    <div className="flex items-center gap-3">
                      <Avatar>
                        <AvatarImage src={member.user.image ?? undefined} />
                        <AvatarFallback>{getInitials(member.user.name)}</AvatarFallback>
                      </Avatar>
                      <div>
                        <div className="font-medium">
                          {member.user.name}
                          {isCurrentUser && (
                            <span className="ml-2 text-xs text-muted-foreground">(You)</span>
                          )}
                        </div>
                        <div className="text-sm text-muted-foreground">{member.user.email}</div>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      {canEdit ? (
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button variant="outline" size="sm">
                              {roleLabels[member.role]}
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem
                              onClick={() =>
                                updateRole.mutate({
                                  organizationSlug,
                                  userId: member.userId,
                                  role: "member",
                                })
                              }
                              disabled={member.role === "member"}
                            >
                              Member
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              onClick={() =>
                                updateRole.mutate({
                                  organizationSlug,
                                  userId: member.userId,
                                  role: "admin",
                                })
                              }
                              disabled={member.role === "admin"}
                            >
                              Admin
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              onClick={() =>
                                updateRole.mutate({
                                  organizationSlug,
                                  userId: member.userId,
                                  role: "owner",
                                })
                              }
                              disabled={member.role === "owner"}
                            >
                              Owner
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              className="text-destructive"
                              onClick={() =>
                                removeMember.mutate({
                                  organizationSlug,
                                  userId: member.userId,
                                })
                              }
                            >
                              Remove
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      ) : (
                        <span className="text-sm text-muted-foreground px-3 py-1">
                          {roleLabels[member.role]}
                        </span>
                      )}
                    </div>
                  </div>
                  {index < members.length - 1 && <Separator />}
                </div>
              );
            })}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
