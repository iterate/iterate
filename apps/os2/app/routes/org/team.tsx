import { createFileRoute, useParams } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { MoreHorizontal, UserMinus, Shield, ShieldCheck, User } from "lucide-react";
import { trpc, trpcClient } from "../../lib/trpc.ts";
import { Button } from "../../components/ui/button.tsx";
import { Badge } from "../../components/ui/badge.tsx";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../../components/ui/table.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../../components/ui/dropdown-menu.tsx";
import { useSessionUser } from "../../hooks/use-session-user.ts";

export const Route = createFileRoute("/_auth-required.layout/_/$organizationSlug/team")({
  component: OrgTeamPage,
});

function OrgTeamPage() {
  const params = useParams({ from: "/_auth-required.layout/_/$organizationSlug/team" });
  const queryClient = useQueryClient();
  const { user: currentUser } = useSessionUser();

  const { data: members, isLoading } = useQuery(
    trpc.organization.members.queryOptions({
      organizationSlug: params.organizationSlug,
    }),
  );

  const { data: org } = useQuery(
    trpc.organization.bySlug.queryOptions({
      organizationSlug: params.organizationSlug,
    }),
  );

  const updateRole = useMutation({
    mutationFn: async ({ userId, role }: { userId: string; role: "member" | "admin" | "owner" }) => {
      return trpcClient.organization.updateMemberRole.mutate({
        organizationSlug: params.organizationSlug,
        userId,
        role,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["organization", "members"] });
      toast.success("Role updated!");
    },
    onError: (error) => {
      toast.error("Failed to update role: " + error.message);
    },
  });

  const removeMember = useMutation({
    mutationFn: async (userId: string) => {
      return trpcClient.organization.removeMember.mutate({
        organizationSlug: params.organizationSlug,
        userId,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["organization", "members"] });
      toast.success("Member removed!");
    },
    onError: (error) => {
      toast.error("Failed to remove member: " + error.message);
    },
  });

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-muted-foreground">Loading...</div>
      </div>
    );
  }

  const currentUserRole = org?.role;
  const canManageMembers = currentUserRole === "owner" || currentUserRole === "admin";

  return (
    <div className="p-8 max-w-4xl space-y-6">
      <h1 className="text-2xl font-bold">Team</h1>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>User</TableHead>
            <TableHead>Role</TableHead>
            {canManageMembers && <TableHead className="w-[50px]"></TableHead>}
          </TableRow>
        </TableHeader>
        <TableBody>
          {members?.map((member) => (
            <TableRow key={member.id}>
              <TableCell>
                <div className="flex items-center gap-3">
                  {member.user.image ? (
                    <img
                      src={member.user.image}
                      alt={member.user.name}
                      className="h-8 w-8 rounded-full"
                    />
                  ) : (
                    <div className="h-8 w-8 rounded-full bg-muted flex items-center justify-center text-sm">
                      {member.user.name[0]}
                    </div>
                  )}
                  <div>
                    <div className="font-medium">{member.user.name}</div>
                    <div className="text-sm text-muted-foreground">{member.user.email}</div>
                  </div>
                </div>
              </TableCell>
              <TableCell>
                <Badge
                  variant={
                    member.role === "owner"
                      ? "default"
                      : member.role === "admin"
                        ? "secondary"
                        : "outline"
                  }
                >
                  {member.role === "owner" && <ShieldCheck className="h-3 w-3 mr-1" />}
                  {member.role === "admin" && <Shield className="h-3 w-3 mr-1" />}
                  {member.role === "member" && <User className="h-3 w-3 mr-1" />}
                  {member.role}
                </Badge>
              </TableCell>
              {canManageMembers && (
                <TableCell>
                  {member.userId !== currentUser?.id && (
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon">
                          <MoreHorizontal className="h-4 w-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        {member.role !== "member" && (
                          <DropdownMenuItem
                            onClick={() => updateRole.mutate({ userId: member.userId, role: "member" })}
                          >
                            <User className="h-4 w-4 mr-2" />
                            Make Member
                          </DropdownMenuItem>
                        )}
                        {member.role !== "admin" && (
                          <DropdownMenuItem
                            onClick={() => updateRole.mutate({ userId: member.userId, role: "admin" })}
                          >
                            <Shield className="h-4 w-4 mr-2" />
                            Make Admin
                          </DropdownMenuItem>
                        )}
                        {currentUserRole === "owner" && member.role !== "owner" && (
                          <DropdownMenuItem
                            onClick={() => updateRole.mutate({ userId: member.userId, role: "owner" })}
                          >
                            <ShieldCheck className="h-4 w-4 mr-2" />
                            Make Owner
                          </DropdownMenuItem>
                        )}
                        <DropdownMenuItem
                          onClick={() => removeMember.mutate(member.userId)}
                          className="text-destructive"
                        >
                          <UserMinus className="h-4 w-4 mr-2" />
                          Remove
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  )}
                </TableCell>
              )}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
