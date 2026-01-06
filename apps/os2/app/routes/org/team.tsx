import { createFileRoute } from "@tanstack/react-router";
import { useSuspenseQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useTRPC } from "../../lib/trpc.ts";
import { Button } from "../../components/ui/button.tsx";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../../components/ui/card.tsx";

export const Route = createFileRoute("/_auth.layout/$organizationSlug/team")({
  component: TeamPage,
});

function TeamPage() {
  const { organizationSlug } = Route.useParams();
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  const { data: members } = useSuspenseQuery(
    trpc.organization.getMembers.queryOptions({ organizationSlug }),
  );

  const updateRole = useMutation(trpc.organization.updateMemberRole.mutationOptions());
  const removeMember = useMutation(trpc.organization.removeMember.mutationOptions());

  const handleRoleChange = async (memberId: string, role: "member" | "admin" | "owner") => {
    await updateRole.mutateAsync({ organizationSlug, memberId, role });
    queryClient.invalidateQueries();
    toast.success("Role updated");
  };

  const handleRemove = async (memberId: string) => {
    await removeMember.mutateAsync({ organizationSlug, memberId });
    queryClient.invalidateQueries();
    toast.success("Member removed");
  };

  return (
    <div className="max-w-2xl">
      <h1 className="text-2xl font-bold mb-6">Team Members</h1>

      <Card>
        <CardHeader>
          <CardTitle>Members</CardTitle>
          <CardDescription>Manage your organization members</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-4">
            {members.map((member) => (
              <div
                key={member.id}
                className="flex items-center justify-between py-2 border-b last:border-0"
              >
                <div className="flex items-center gap-3">
                  {member.user.image && (
                    <img src={member.user.image} alt="" className="w-8 h-8 rounded-full" />
                  )}
                  <div>
                    <div className="font-medium">{member.user.name}</div>
                    <div className="text-sm text-muted-foreground">{member.user.email}</div>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <select
                    value={member.role}
                    onChange={(e) =>
                      handleRoleChange(member.id, e.target.value as "member" | "admin" | "owner")
                    }
                    className="text-sm border rounded px-2 py-1"
                  >
                    <option value="member">Member</option>
                    <option value="admin">Admin</option>
                    <option value="owner">Owner</option>
                  </select>
                  {member.role !== "owner" && (
                    <Button variant="ghost" size="sm" onClick={() => handleRemove(member.id)}>
                      Remove
                    </Button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
