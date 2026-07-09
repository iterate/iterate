// Shared pieces of the /projects organization-management pages. The `-`
// filename prefix keeps this out of the generated route tree (TanStack
// Router's convention for colocated non-route files).
import { useMemo, useState, type ReactNode } from "react";
import { z } from "zod/v4";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@iterate-com/ui/components/alert-dialog";
import { Badge } from "@iterate-com/ui/components/badge";
import { Button } from "@iterate-com/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@iterate-com/ui/components/dialog";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@iterate-com/ui/components/empty";
import { Field, FieldError, FieldGroup, FieldLabel } from "@iterate-com/ui/components/field";
import { Identifier } from "@iterate-com/ui/components/identifier";
import { Input } from "@iterate-com/ui/components/input";
import { NativeSelect, NativeSelectOption } from "@iterate-com/ui/components/native-select";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { toast } from "@iterate-com/ui/components/sonner";
import { orpcClient } from "../../utils/query.tsx";
import {
  inventoryQueryOptions,
  organizationInvitationsQueryKey,
  organizationManagementSections,
  organizationMembersQueryKey,
  type InventoryOrganization,
  type OrganizationManagementSection,
  type Project,
} from "./-projects-data.ts";

const organizationRoles = ["member", "admin", "owner"] as const;
type OrganizationRole = (typeof organizationRoles)[number];

const memberAdminRoles = ["member", "admin"] as const satisfies readonly OrganizationRole[];

type OrganizationMember = Awaited<ReturnType<typeof orpcClient.organization.members>>[number];

export function OrganizationRail(props: {
  organizations: InventoryOrganization[];
  selectedOrganizationSlug: string;
  selectedSection: OrganizationManagementSection;
}) {
  return (
    <aside className="overflow-hidden rounded-lg border bg-card">
      <div className="border-b px-4 py-3">
        <p className="text-sm font-medium">Organizations</p>
        <p className="text-xs text-muted-foreground">Choose one to manage.</p>
      </div>
      <div className="max-h-[620px] overflow-y-auto p-2">
        {props.organizations.map((organization) => {
          const selected = organization.slug === props.selectedOrganizationSlug;
          return (
            <Link
              key={organization.id}
              to="/projects/{-$organizationSlug}"
              params={{ organizationSlug: organization.slug }}
              search={{
                section: props.selectedSection === "projects" ? undefined : props.selectedSection,
              }}
              className={[
                "flex w-full items-start gap-3 rounded-md px-3 py-3 text-left transition-colors",
                selected ? "bg-primary text-primary-foreground" : "hover:bg-muted",
              ].join(" ")}
            >
              <span
                className={[
                  "flex size-9 shrink-0 items-center justify-center rounded-md border text-xs font-semibold",
                  selected ? "border-primary-foreground/30" : "bg-background",
                ].join(" ")}
              >
                {organization.name.slice(0, 2).toUpperCase()}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">{organization.name}</span>
                <span
                  className={[
                    "block truncate text-xs",
                    selected ? "text-primary-foreground/75" : "text-muted-foreground",
                  ].join(" ")}
                >
                  {organization.projects.length} project
                  {organization.projects.length === 1 ? "" : "s"} · {organization.role}
                </span>
              </span>
            </Link>
          );
        })}
      </div>
    </aside>
  );
}

export function OrganizationDetail(props: {
  organization: InventoryOrganization;
  canManage: boolean;
  canManageOwnerRoles: boolean;
  currentUserId: string;
  activeSection: OrganizationManagementSection;
  onCreateProject: () => void;
  onDeleteOrganization: () => void;
  onDeleteProject: (project: Project) => void;
}) {
  return (
    <section className="min-w-0 overflow-hidden rounded-lg border bg-card">
      <div className="flex flex-col gap-4 border-b px-5 py-4 md:flex-row md:items-start md:justify-between">
        <div className="min-w-0 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="truncate text-lg font-semibold">{props.organization.name}</h2>
            <Badge variant={props.organization.role === "owner" ? "default" : "outline"}>
              {props.organization.role}
            </Badge>
          </div>
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
            <span>{props.organization.slug}</span>
            <span>{props.organization.projects.length} projects</span>
            <Identifier value={props.organization.id} textClassName="text-xs" />
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" disabled={!props.canManage} onClick={props.onCreateProject}>
            New project
          </Button>
          <Button
            size="sm"
            variant="destructive"
            disabled={props.organization.role !== "owner"}
            onClick={props.onDeleteOrganization}
          >
            Delete
          </Button>
        </div>
      </div>

      <OrganizationSectionNav
        organizationSlug={props.organization.slug}
        activeSection={props.activeSection}
        canManage={props.canManage}
      />

      <div id="organization-projects" className="scroll-mt-4 border-b">
        <div className="border-b px-5 py-3">
          <h3 className="text-sm font-medium">Projects</h3>
        </div>
        {props.organization.projects.length === 0 ? (
          <Empty className="min-h-[280px] border-0">
            <EmptyHeader>
              <EmptyTitle>No projects in this organization</EmptyTitle>
              <EmptyDescription>Create one when this organization is ready.</EmptyDescription>
            </EmptyHeader>
            <Button disabled={!props.canManage} onClick={props.onCreateProject}>
              Create project
            </Button>
          </Empty>
        ) : (
          <div className="divide-y">
            {props.organization.projects.map((project) => (
              <ProjectRow
                key={project.id}
                project={project}
                canManage={props.canManage}
                onDelete={() => props.onDeleteProject(project)}
              />
            ))}
          </div>
        )}
      </div>

      <OrganizationMembersPanel
        organizationId={props.organization.id}
        organizationSlug={props.organization.slug}
        canManage={props.canManage}
        currentUserRole={
          props.canManageOwnerRoles ? "owner" : toOrganizationRole(props.organization.role)
        }
        canManageOwnerRoles={props.canManageOwnerRoles}
        currentUserId={props.currentUserId}
      />
    </section>
  );
}

function OrganizationSectionNav(props: {
  organizationSlug: string;
  activeSection: OrganizationManagementSection;
  canManage: boolean;
}) {
  const sections = props.canManage ? organizationManagementSections : memberAdminVisibleSections;
  return (
    <nav className="flex flex-wrap gap-2 border-b px-5 py-3" aria-label="Organization sections">
      {sections.map((section) => (
        <Link
          key={section}
          to="/projects/{-$organizationSlug}"
          params={{ organizationSlug: props.organizationSlug }}
          search={{ section: section === "projects" ? undefined : section }}
          aria-current={props.activeSection === section ? "page" : undefined}
          className={[
            "rounded-md px-3 py-1.5 text-sm transition-colors",
            props.activeSection === section
              ? "bg-primary text-primary-foreground"
              : "text-muted-foreground hover:bg-muted hover:text-foreground",
          ].join(" ")}
        >
          {section.slice(0, 1).toUpperCase() + section.slice(1)}
        </Link>
      ))}
    </nav>
  );
}

function ProjectRow(props: { project: Project; canManage: boolean; onDelete: () => void }) {
  const metadataKeys = Object.keys(props.project.metadata);
  return (
    <article className="grid gap-3 px-5 py-4 md:grid-cols-[minmax(0,1fr)_auto] md:items-center">
      <div className="min-w-0 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="truncate text-sm font-medium">{props.project.name}</h3>
          {props.project.archivedAt ? <Badge variant="secondary">Archived</Badge> : null}
        </div>
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
          <span>{props.project.slug}</span>
          <Identifier value={props.project.id} textClassName="text-xs" />
          <span>
            {metadataKeys.length === 0
              ? "No metadata"
              : `${metadataKeys.length} metadata ${metadataKeys.length === 1 ? "key" : "keys"}`}
          </span>
        </div>
      </div>
      <div className="flex gap-2">
        <Button
          size="sm"
          variant="destructive"
          disabled={!props.canManage}
          onClick={props.onDelete}
        >
          Delete
        </Button>
      </div>
    </article>
  );
}

function OrganizationMembersPanel(props: {
  organizationId: string;
  organizationSlug: string;
  canManage: boolean;
  canManageOwnerRoles: boolean;
  currentUserRole: OrganizationRole;
  currentUserId: string;
}) {
  const queryClient = useQueryClient();
  const [memberToRemove, setMemberToRemove] = useState<OrganizationMember | null>(null);

  const refreshMembers = async () => {
    await Promise.all([
      queryClient.invalidateQueries({
        queryKey: organizationMembersQueryKey(props.organizationId),
      }),
      queryClient.invalidateQueries({
        queryKey: organizationInvitationsQueryKey(props.organizationId),
      }),
      queryClient.invalidateQueries({ queryKey: inventoryQueryOptions().queryKey }),
    ]);
  };

  const membersQuery = useQuery({
    queryKey: organizationMembersQueryKey(props.organizationId),
    queryFn: () => orpcClient.organization.members({ organizationSlug: props.organizationSlug }),
  });

  const invitationsQuery = useQuery({
    queryKey: organizationInvitationsQueryKey(props.organizationId),
    enabled: props.canManage,
    queryFn: () =>
      orpcClient.organization.listInvites({ organizationSlug: props.organizationSlug }),
  });

  const inviteMember = useMutation({
    mutationFn: (input: { email: string; role: OrganizationRole }) =>
      orpcClient.organization.createInvite({
        organizationSlug: props.organizationSlug,
        email: input.email,
        role: input.role,
      }),
    onSuccess: async () => {
      toast.success("Invitation created");
      await refreshMembers();
    },
    onError: (error) => toast.error(error.message),
  });

  const updateMemberRole = useMutation({
    mutationFn: (input: { userId: string; role: OrganizationRole }) =>
      orpcClient.organization.updateMemberRole({
        organizationSlug: props.organizationSlug,
        userId: input.userId,
        role: input.role,
      }),
    onSuccess: async () => {
      toast.success("Member role updated");
      await refreshMembers();
    },
    onError: (error) => toast.error(error.message),
  });

  const removeMember = useMutation({
    mutationFn: (userId: string) =>
      orpcClient.organization.removeMember({
        organizationSlug: props.organizationSlug,
        userId,
      }),
    onSuccess: async () => {
      toast.success("Member removed");
      setMemberToRemove(null);
      await refreshMembers();
    },
    onError: (error) => toast.error(error.message),
  });

  const cancelInvitation = useMutation({
    mutationFn: (invitationId: string) =>
      orpcClient.organization.cancelInvite({
        organizationSlug: props.organizationSlug,
        inviteId: invitationId,
      }),
    onSuccess: async () => {
      toast.success("Invitation canceled");
      await refreshMembers();
    },
    onError: (error) => toast.error(error.message),
  });

  const members = membersQuery.data ?? [];
  const invitations = invitationsQuery.data ?? [];
  const manageableRoles: readonly OrganizationRole[] = props.canManageOwnerRoles
    ? organizationRoles
    : memberAdminRoles;

  return (
    <section id="organization-members" className="scroll-mt-4">
      <div className="border-b px-5 py-3">
        <h3 className="text-sm font-medium">Members</h3>
      </div>

      {props.canManage ? (
        <div className="border-b px-5 py-4">
          <InviteMemberForm
            isPending={inviteMember.isPending}
            roleOptions={manageableRoles}
            onSubmit={(input) => inviteMember.mutateAsync(input).then(() => undefined)}
          />
        </div>
      ) : null}

      {membersQuery.isPending ? (
        <div className="px-5 py-6 text-sm text-muted-foreground">Loading members...</div>
      ) : membersQuery.isError ? (
        <div className="px-5 py-6">
          <p className="text-sm text-destructive">{membersQuery.error.message}</p>
          <Button
            className="mt-3"
            size="sm"
            variant="outline"
            onClick={() => membersQuery.refetch()}
          >
            Try again
          </Button>
        </div>
      ) : (
        <div className="divide-y">
          {members.map((member) => (
            <MemberRow
              key={member.id}
              member={member}
              canManage={props.canManage}
              currentUserRole={props.currentUserRole}
              roleOptions={manageableRoles}
              isCurrentUser={member.userId === props.currentUserId}
              isUpdatingRole={
                updateMemberRole.isPending && updateMemberRole.variables?.userId === member.userId
              }
              onRoleChange={(role) => updateMemberRole.mutate({ userId: member.userId, role })}
              onRemove={() => setMemberToRemove(member)}
            />
          ))}
        </div>
      )}

      {props.canManage ? (
        <>
          <section id="organization-invitations" className="scroll-mt-4">
            <div className="border-t px-5 py-3">
              <h3 className="text-sm font-medium">Pending invitations</h3>
            </div>
            {invitationsQuery.isPending ? (
              <div className="px-5 py-6 text-sm text-muted-foreground">Loading invitations...</div>
            ) : invitationsQuery.isError ? (
              <div className="px-5 py-6">
                <p className="text-sm text-destructive">{invitationsQuery.error.message}</p>
                <Button
                  className="mt-3"
                  size="sm"
                  variant="outline"
                  onClick={() => invitationsQuery.refetch()}
                >
                  Try again
                </Button>
              </div>
            ) : invitations.length === 0 ? (
              <div className="px-5 py-6 text-sm text-muted-foreground">No pending invitations.</div>
            ) : (
              <div className="divide-y">
                {invitations.map((invitation) => (
                  <PendingInvitationRow
                    key={invitation.id}
                    invitation={invitation}
                    organizationSlug={props.organizationSlug}
                    canManage={props.canManage}
                    isCanceling={
                      cancelInvitation.isPending && cancelInvitation.variables === invitation.id
                    }
                    onCancel={() => cancelInvitation.mutate(invitation.id)}
                  />
                ))}
              </div>
            )}
          </section>
        </>
      ) : null}

      <RemoveMemberDialog
        member={memberToRemove}
        isPending={removeMember.isPending}
        onOpenChange={(open) => !open && setMemberToRemove(null)}
        onConfirm={() => {
          if (memberToRemove) removeMember.mutate(memberToRemove.userId);
        }}
      />
    </section>
  );
}

const InviteMemberInput = z.object({
  email: z.string().trim().email("Enter a valid email address"),
  role: z.enum(organizationRoles),
});

function InviteMemberForm(props: {
  isPending: boolean;
  roleOptions: readonly OrganizationRole[];
  onSubmit: (input: z.infer<typeof InviteMemberInput>) => Promise<void>;
}) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<OrganizationRole>("member");
  const parsed = useMemo(() => InviteMemberInput.safeParse({ email, role }), [email, role]);
  const submitInvite = () => {
    if (!parsed.success || props.isPending) return;
    void props
      .onSubmit(parsed.data)
      .then(() => {
        setEmail("");
        setRole("member");
      })
      .catch(() => undefined);
  };

  return (
    <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_160px_auto] md:items-end">
      <Field data-invalid={!parsed.success && email.length > 0}>
        <FieldLabel htmlFor="member-email">Email</FieldLabel>
        <Input
          id="member-email"
          type="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") submitInvite();
          }}
          disabled={props.isPending}
          aria-invalid={!parsed.success && email.length > 0}
        />
        {!parsed.success && email.length > 0 ? <FieldError errors={parsed.error.issues} /> : null}
      </Field>
      <Field>
        <FieldLabel htmlFor="member-role">Role</FieldLabel>
        <NativeSelect
          id="member-role"
          value={role}
          onChange={(event) => setRole(toOrganizationRole(event.target.value))}
          disabled={props.isPending}
        >
          {props.roleOptions.map((roleOption) => (
            <NativeSelectOption key={roleOption} value={roleOption}>
              {formatOrganizationRole(roleOption)}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      </Field>
      <Button type="button" disabled={!parsed.success || props.isPending} onClick={submitInvite}>
        {props.isPending ? "Inviting..." : "Invite"}
      </Button>
    </div>
  );
}

function MemberRow(props: {
  member: OrganizationMember;
  canManage: boolean;
  currentUserRole: OrganizationRole;
  roleOptions: readonly OrganizationRole[];
  isCurrentUser: boolean;
  isUpdatingRole: boolean;
  onRoleChange: (role: OrganizationRole) => void;
  onRemove: () => void;
}) {
  const role = toOrganizationRole(props.member.role);
  const canEditMember = canManageMember({
    canManage: props.canManage,
    currentUserRole: props.currentUserRole,
    targetRole: role,
    isCurrentUser: props.isCurrentUser,
  });
  const roleOptions = props.roleOptions.includes(role) ? props.roleOptions : organizationRoles;
  return (
    <article className="grid gap-3 px-5 py-4 md:grid-cols-[minmax(0,1fr)_160px_auto] md:items-center">
      <div className="flex min-w-0 items-center gap-3">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-md bg-muted text-xs font-semibold">
          {memberInitials(props.member)}
        </div>
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <p className="truncate text-sm font-medium">
              {props.member.user.name || props.member.user.email}
            </p>
            {props.isCurrentUser ? <Badge variant="secondary">You</Badge> : null}
          </div>
          <p className="truncate text-xs text-muted-foreground">{props.member.user.email}</p>
        </div>
      </div>
      <NativeSelect
        value={role}
        aria-label={`Role for ${props.member.user.email}`}
        disabled={!canEditMember || props.isUpdatingRole}
        onChange={(event) => {
          const nextRole = toOrganizationRole(event.target.value);
          if (nextRole !== role) props.onRoleChange(nextRole);
        }}
      >
        {roleOptions.map((roleOption) => (
          <NativeSelectOption key={roleOption} value={roleOption}>
            {formatOrganizationRole(roleOption)}
          </NativeSelectOption>
        ))}
      </NativeSelect>
      <Button
        size="sm"
        variant="destructive"
        aria-label={`Remove ${props.member.user.email}`}
        disabled={!canEditMember}
        onClick={props.onRemove}
      >
        Remove
      </Button>
    </article>
  );
}

function PendingInvitationRow(props: {
  invitation: Awaited<ReturnType<typeof orpcClient.organization.listInvites>>[number];
  organizationSlug: string;
  canManage: boolean;
  isCanceling: boolean;
  onCancel: () => void;
}) {
  return (
    <article className="grid gap-3 px-5 py-4 md:grid-cols-[minmax(0,1fr)_auto] md:items-center">
      <div className="min-w-0 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <p className="truncate text-sm font-medium">{props.invitation.email}</p>
          <Badge variant="outline">
            {formatOrganizationRole(toOrganizationRole(props.invitation.role))}
          </Badge>
        </div>
        <p className="truncate text-xs text-muted-foreground">Pending</p>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="outline"
          aria-label={`Copy invitation link for ${props.invitation.email}`}
          onClick={() => copyInvitationLink(props.invitation.id, props.organizationSlug)}
        >
          Copy link
        </Button>
        <Button
          size="sm"
          variant="destructive"
          aria-label={`Cancel invitation for ${props.invitation.email}`}
          disabled={!props.canManage || props.isCanceling}
          onClick={props.onCancel}
        >
          {props.isCanceling ? "Canceling..." : "Cancel"}
        </Button>
      </div>
    </article>
  );
}

function RemoveMemberDialog(props: {
  member: OrganizationMember | null;
  isPending: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}) {
  return (
    <AlertDialog open={Boolean(props.member)} onOpenChange={props.onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Remove member?</AlertDialogTitle>
          <AlertDialogDescription>
            {props.member
              ? `${props.member.user.email} will lose access to this organization.`
              : "This member will lose access to this organization."}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={props.isPending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={props.isPending}
            onClick={props.onConfirm}
          >
            {props.isPending ? "Removing..." : "Remove"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function copyInvitationLink(invitationId: string, organizationSlug: string) {
  if (typeof window === "undefined" || !navigator.clipboard) {
    toast.error("Clipboard is unavailable");
    return;
  }
  const invitationUrl = new URL(`/invitations/${invitationId}`, window.location.origin);
  invitationUrl.searchParams.set("organization", organizationSlug);
  void navigator.clipboard
    .writeText(invitationUrl.toString())
    .then(() => toast.success("Invitation link copied"))
    .catch(() => toast.error("Could not copy invitation link"));
}

function memberInitials(member: OrganizationMember) {
  const seed = member.user.name || member.user.email;
  const parts = seed.trim().split(/\s+/).filter(Boolean);
  if (parts.length >= 2) {
    return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
  }
  return seed.slice(0, 2).toUpperCase();
}

function toOrganizationRole(role: string): OrganizationRole {
  return role === "owner" || role === "admin" ? role : "member";
}

function canManageMember(input: {
  canManage: boolean;
  currentUserRole: OrganizationRole;
  targetRole: OrganizationRole;
  isCurrentUser: boolean;
}) {
  if (!input.canManage || input.isCurrentUser) return false;
  if (input.targetRole === "owner" && input.currentUserRole !== "owner") return false;
  return true;
}

function formatOrganizationRole(role: OrganizationRole) {
  return role.slice(0, 1).toUpperCase() + role.slice(1);
}

const memberAdminVisibleSections = [
  "projects",
  "members",
] as const satisfies readonly OrganizationManagementSection[];

// The selected organization is the parent's `state`, not local state — the
// select writes straight back through onStateChange, so there's nothing to
// sync.
export function ProjectDialog(props: {
  state: { organizationSlug: string } | null;
  organizations: InventoryOrganization[];
  isPending: boolean;
  onOpenChange: (open: boolean) => void;
  onStateChange: (state: { organizationSlug: string }) => void;
  onSubmit: (input: { name: string; organizationSlug: string }) => void;
}) {
  return (
    <NameDialog
      key={props.state?.organizationSlug ?? "create-project-closed"}
      open={Boolean(props.state)}
      title="Create project"
      description="Name the project users should recognize."
      label="Project name"
      submitLabel="Create project"
      isPending={props.isPending}
      onOpenChange={props.onOpenChange}
      extraFields={
        props.state ? (
          <Field>
            <FieldLabel htmlFor="project-organization">Organization</FieldLabel>
            <NativeSelect
              id="project-organization"
              className="w-full"
              value={props.state.organizationSlug}
              onChange={(event) => props.onStateChange({ organizationSlug: event.target.value })}
              disabled={props.isPending}
            >
              {props.organizations.map((organization) => (
                <NativeSelectOption key={organization.id} value={organization.slug}>
                  {organization.name}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </Field>
        ) : null
      }
      onSubmit={(input) =>
        props.state && props.onSubmit({ ...input, organizationSlug: props.state.organizationSlug })
      }
    />
  );
}

const NameInput = z.object({
  name: z.string().trim().min(1, "Name is required").max(100, "Keep it under 100 characters"),
});

export function NameDialog(props: {
  open: boolean;
  title: string;
  description: string;
  label: string;
  submitLabel: string;
  isPending: boolean;
  extraFields?: ReactNode;
  onOpenChange: (open: boolean) => void;
  onSubmit: (input: z.infer<typeof NameInput>) => void;
}) {
  const [name, setName] = useState("");
  const parsed = NameInput.safeParse({ name });

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{props.title}</DialogTitle>
          <DialogDescription>{props.description}</DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (!parsed.success) return;
            props.onSubmit(parsed.data);
          }}
        >
          <FieldGroup>
            {props.extraFields}
            <Field data-invalid={!parsed.success && name.length > 0}>
              <FieldLabel htmlFor="name">{props.label}</FieldLabel>
              <Input
                id="name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                disabled={props.isPending}
                aria-invalid={!parsed.success && name.length > 0}
              />
              {!parsed.success && name.length > 0 ? (
                <FieldError errors={parsed.error.issues} />
              ) : null}
            </Field>
          </FieldGroup>
          <DialogFooter showCloseButton>
            <Button type="submit" disabled={!parsed.success || props.isPending}>
              {props.isPending ? "Saving..." : props.submitLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function DeleteOrganizationDialog(props: {
  organization: InventoryOrganization | null;
  isPending: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}) {
  return (
    <AlertDialog open={Boolean(props.organization)} onOpenChange={props.onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete organization?</AlertDialogTitle>
          <AlertDialogDescription>
            {props.organization
              ? `${props.organization.name} and its ${props.organization.projects.length} projects will be removed.`
              : "This organization will be removed."}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={props.isPending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={props.isPending}
            onClick={props.onConfirm}
          >
            {props.isPending ? "Deleting..." : "Delete"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export function DeleteProjectDialog(props: {
  project: Project | null;
  isPending: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}) {
  return (
    <AlertDialog open={Boolean(props.project)} onOpenChange={props.onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete project?</AlertDialogTitle>
          <AlertDialogDescription>
            {props.project
              ? `${props.project.name} will stop appearing in project access grants.`
              : "This project will be removed."}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={props.isPending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={props.isPending}
            onClick={props.onConfirm}
          >
            {props.isPending ? "Deleting..." : "Delete"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
