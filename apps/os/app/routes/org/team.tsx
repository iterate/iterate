import { Suspense } from "react";
import { Loader2 } from "lucide-react";
import { useSuspenseQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useTRPC } from "../../lib/trpc.ts";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../../components/ui/table.tsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select.tsx";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../../components/ui/card.tsx";
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
        // Invalidate the members query to refetch the data
        queryClient.invalidateQueries({
          queryKey: trpc.organization.listMembers.queryKey({ organizationId }),
        });
      },
    }),
  );

  const handleRoleChange = (userId: string, role: string) => {
    updateRole.mutate({
      organizationId,
      userId,
      role: role as "member" | "admin" | "owner" | "guest",
    });
  };

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-3xl font-bold mb-2">Team Members</h1>
        <p className="text-muted-foreground text-lg">
          Manage your organization team members and their roles
        </p>
      </div>

      <Card variant="muted">
        <CardHeader>
          <CardTitle>Members</CardTitle>
          <CardDescription>
            {members.length} {members.length === 1 ? "member" : "members"}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Email</TableHead>
                <TableHead>Role</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {members.map((member) => {
                const isCurrentUser = member.userId === currentUser.id;
                return (
                  <TableRow key={member.id}>
                    <TableCell className="font-medium">
                      {member.name}
                      {isCurrentUser && (
                        <span className="ml-2 text-xs text-muted-foreground">(You)</span>
                      )}
                    </TableCell>
                    <TableCell>{member.email}</TableCell>
                    <TableCell>
                      {isCurrentUser ? (
                        <span className="text-sm">{roleLabels[member.role]}</span>
                      ) : (
                        <Select
                          value={member.role}
                          onValueChange={(value) => handleRoleChange(member.userId, value)}
                          disabled={updateRole.isPending}
                        >
                          <SelectTrigger className="w-[120px]">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="owner">Owner</SelectItem>
                            <SelectItem value="admin">Admin</SelectItem>
                            <SelectItem value="member">Member</SelectItem>
                            <SelectItem value="guest">Guest</SelectItem>
                          </SelectContent>
                        </Select>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
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
      <OrganizationTeamContent organizationId={organizationId} />
    </Suspense>
  );
}
