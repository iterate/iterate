import { useState } from "react";
import { createFileRoute, useParams } from "@tanstack/react-router";
import { useSuspenseQuery, useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { MoreHorizontal, UserMinus, Shield, ShieldCheck, User } from "lucide-react";
import { trpc, trpcClient } from "../../lib/trpc.tsx";
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
import { Field, FieldGroup, FieldLabel, FieldSet } from "../../components/ui/field.tsx";
import { Input } from "../../components/ui/input.tsx";

export const Route = createFileRoute("/_auth/orgs/$organizationSlug/team")({
  // loader: For data fetching (runs in parallel after beforeLoad)
  loader: async ({ context, params }) => {
    await Promise.all([
      context.queryClient.ensureQueryData(
        trpc.organization.members.queryOptions({
          organizationSlug: params.organizationSlug,
        }),
      ),
      context.queryClient.ensureQueryData(
        trpc.organization.bySlug.queryOptions({
          organizationSlug: params.organizationSlug,
        }),
      ),
    ]);
  },
  component: OrgTeamPage,
});

function OrgTeamPage() {
  const params = useParams({ from: "/_auth/orgs/$organizationSlug/team" });
  const { user: currentUser } = useSessionUser();
  const [email, setEmail] = useState("");

  const { data: members } = useSuspenseQuery(
    trpc.organization.members.queryOptions({
      organizationSlug: params.organizationSlug,
    }),
  );

  const { data: org } = useSuspenseQuery(
    trpc.organization.bySlug.queryOptions({
      organizationSlug: params.organizationSlug,
    }),
  );

  const updateRole = useMutation({
    mutationFn: async ({
      userId,
      role,
    }: {
      userId: string;
      role: "member" | "admin" | "owner";
    }) => {
      return trpcClient.organization.updateMemberRole.mutate({
        organizationSlug: params.organizationSlug,
        userId,
        role,
      });
    },
    onSuccess: () => {
      toast.success("Role updated!");
    },
    onError: (error) => {
      toast.error("Failed to update role: " + error.message);
    },
  });

  const addMember = useMutation({
    mutationFn: async (emailAddress: string) => {
      return trpcClient.organization.addMember.mutate({
        organizationSlug: params.organizationSlug,
        email: emailAddress,
      });
    },
    onSuccess: () => {
      setEmail("");
      toast.success("Member added!");
    },
    onError: (error) => {
      toast.error("Failed to add member: " + error.message);
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
      toast.success("Member removed!");
    },
    onError: (error) => {
      toast.error("Failed to remove member: " + error.message);
    },
  });

  const currentUserRole = org?.role;
  const canManageMembers = currentUserRole === "owner" || currentUserRole === "admin";

  return (
    <div className="p-4 space-y-6">
      {canManageMembers && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (email.trim()) {
              addMember.mutate(email.trim());
            }
          }}
        >
          <FieldGroup>
            <FieldSet>
              <Field>
                <FieldLabel htmlFor="member-email">Add member by email</FieldLabel>
                <Input
                  id="member-email"
                  type="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  placeholder="name@company.com"
                  disabled={addMember.isPending}
                  autoFocus
                />
              </Field>
            </FieldSet>
            <Field orientation="horizontal">
              <Button type="submit" disabled={!email.trim() || addMember.isPending}>
                {addMember.isPending ? "Adding..." : "Add member"}
              </Button>
            </Field>
          </FieldGroup>
        </form>
      )}
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
                            onClick={() =>
                              updateRole.mutate({ userId: member.userId, role: "member" })
                            }
                          >
                            <User className="h-4 w-4 mr-2" />
                            Make Member
                          </DropdownMenuItem>
                        )}
                        {member.role !== "admin" && (
                          <DropdownMenuItem
                            onClick={() =>
                              updateRole.mutate({ userId: member.userId, role: "admin" })
                            }
                          >
                            <Shield className="h-4 w-4 mr-2" />
                            Make Admin
                          </DropdownMenuItem>
                        )}
                        {currentUserRole === "owner" && member.role !== "owner" && (
                          <DropdownMenuItem
                            onClick={() =>
                              updateRole.mutate({ userId: member.userId, role: "owner" })
                            }
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
