import { useState } from "react";
import { createFileRoute, useParams } from "@tanstack/react-router";
import { useSuspenseQuery, useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { MoreHorizontal, UserMinus, Shield, ShieldCheck, User, Mail, X } from "lucide-react";
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
  loader: ({ context, params }) => {
    // Non-blocking prefetch - speeds up perceived load time
    context.queryClient.prefetchQuery(
      trpc.organization.members.queryOptions({ organizationSlug: params.organizationSlug }),
    );
    context.queryClient.prefetchQuery(
      trpc.organization.bySlug.queryOptions({ organizationSlug: params.organizationSlug }),
    );
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

  const { data: pendingInvites } = useSuspenseQuery(
    trpc.organization.listInvites.queryOptions({
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

  const createInvite = useMutation({
    mutationFn: async (emailAddress: string) => {
      return trpcClient.organization.createInvite.mutate({
        organizationSlug: params.organizationSlug,
        email: emailAddress,
      });
    },
    onSuccess: () => {
      setEmail("");
      toast.success("Invite sent!");
    },
    onError: (error: Error) => {
      toast.error(error.message);
    },
  });

  const cancelInvite = useMutation({
    mutationFn: async (inviteId: string) => {
      return trpcClient.organization.cancelInvite.mutate({
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
              createInvite.mutate(email.trim());
            }
          }}
        >
          <FieldGroup>
            <FieldSet>
              <Field>
                <FieldLabel htmlFor="member-email">Invite by email</FieldLabel>
                <Input
                  id="member-email"
                  type="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  placeholder="name@company.com"
                  disabled={createInvite.isPending}
                  autoFocus
                />
              </Field>
            </FieldSet>
            <Field orientation="horizontal">
              <Button type="submit" disabled={!email.trim() || createInvite.isPending}>
                {createInvite.isPending ? "Sending..." : "Invite"}
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
          {pendingInvites?.map((invite) => (
            <TableRow key={invite.id} className="text-muted-foreground">
              <TableCell>
                <div className="flex items-center gap-3">
                  <div className="h-8 w-8 rounded-full bg-muted flex items-center justify-center">
                    <Mail className="h-4 w-4" />
                  </div>
                  <div>
                    <div className="font-medium">{invite.email}</div>
                    <div className="text-sm">Pending invite</div>
                  </div>
                </div>
              </TableCell>
              <TableCell>
                <Badge variant="outline">{invite.role}</Badge>
              </TableCell>
              {canManageMembers && (
                <TableCell>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => cancelInvite.mutate(invite.id)}
                  >
                    <X className="h-4 w-4" />
                  </Button>
                </TableCell>
              )}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
