import { useState, type FormEvent, Suspense } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useMutation, useSuspenseQuery } from "@tanstack/react-query";
import { useTheme } from "next-themes";
import { toast } from "sonner";
import { Mail, LogOut, Check, X } from "lucide-react";
import { trpc, trpcClient } from "../../lib/trpc.tsx";
import { Button } from "../../components/ui/button.tsx";
import { CenteredLayout } from "../../components/centered-layout.tsx";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldSet,
} from "../../components/ui/field.tsx";
import { Input } from "../../components/ui/input.tsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../components/ui/dialog.tsx";

export const Route = createFileRoute("/_auth/user/settings")({
  component: UserSettingsRoute,
});

function UserSettingsRoute() {
  return (
    <CenteredLayout>
      <Suspense fallback={<div className="text-muted-foreground">Loading...</div>}>
        <UserSettingsPage />
      </Suspense>
    </CenteredLayout>
  );
}

function UserSettingsPage() {
  const { data: user } = useSuspenseQuery(trpc.user.me.queryOptions());
  const { data: memberships } = useSuspenseQuery(trpc.user.memberships.queryOptions());
  const { data: pendingInvites } = useSuspenseQuery(
    trpc.organization.myPendingInvites.queryOptions(),
  );
  const navigate = useNavigate();

  const updateUser = useMutation({
    mutationFn: async (name: string) => {
      return trpcClient.user.updateSettings.mutate({ name });
    },
    onSuccess: () => {
      toast.success("Settings updated");
    },
    onError: (error) => {
      toast.error("Failed to update settings: " + error.message);
    },
  });

  const acceptInvite = useMutation({
    mutationFn: async (inviteId: string) => {
      return trpcClient.organization.acceptInvite.mutate({ inviteId });
    },
    onSuccess: (org) => {
      toast.success(`Joined ${org.name}!`);
      navigate({ to: "/orgs/$organizationSlug", params: { organizationSlug: org.slug } });
    },
    onError: (error) => {
      toast.error("Failed to accept invite: " + error.message);
    },
  });

  const declineInvite = useMutation({
    mutationFn: async (inviteId: string) => {
      return trpcClient.organization.declineInvite.mutate({ inviteId });
    },
    onSuccess: () => {
      toast.success("Invite declined");
    },
    onError: (error) => {
      toast.error("Failed to decline invite: " + error.message);
    },
  });

  if (!user) {
    return <div className="text-muted-foreground">User not found</div>;
  }

  return (
    <div className="w-full max-w-md space-y-8">
      <UserSettingsForm
        key={user.id}
        user={{ id: user.id, name: user.name, email: user.email }}
        isSaving={updateUser.isPending}
        onSubmit={(name) => updateUser.mutate(name)}
      />

      {pendingInvites && pendingInvites.length > 0 && (
        <div className="space-y-4">
          <h2 className="text-lg font-semibold">Pending invites</h2>
          <div className="space-y-3">
            {pendingInvites.map((invite) => (
              <div
                key={invite.id}
                className="flex items-center justify-between gap-4 p-4 border rounded-lg bg-card"
              >
                <div className="flex items-center gap-3 min-w-0">
                  <Mail className="h-5 w-5 text-muted-foreground shrink-0" />
                  <div className="min-w-0">
                    <div className="font-medium truncate">{invite.organization.name}</div>
                    <div className="text-sm text-muted-foreground">
                      Invited by {invite.invitedBy.name} as {invite.role}
                    </div>
                  </div>
                </div>
                <div className="flex gap-2 shrink-0">
                  <Button
                    size="sm"
                    onClick={() => acceptInvite.mutate(invite.id)}
                    disabled={acceptInvite.isPending || declineInvite.isPending}
                  >
                    <Check className="h-4 w-4" />
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => declineInvite.mutate(invite.id)}
                    disabled={acceptInvite.isPending || declineInvite.isPending}
                  >
                    <X className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {memberships && memberships.length > 0 && (
        <div className="space-y-4">
          <h2 className="text-lg font-semibold">Organizations</h2>
          <div className="space-y-3">
            {memberships.map((membership) => (
              <OrgMembershipCard key={membership.id} membership={membership} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

type UserSettingsFormProps = {
  user: {
    id: string;
    name: string;
    email: string;
  };
  isSaving: boolean;
  onSubmit: (name: string) => void;
};

function UserSettingsForm({ user, isSaving, onSubmit }: UserSettingsFormProps) {
  const [name, setName] = useState(user.name);
  const { theme, setTheme } = useTheme();

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (name.trim() && name !== user.name) {
      onSubmit(name.trim());
    }
  };

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">User settings</h1>
      <form onSubmit={handleSubmit}>
        <FieldGroup>
          <FieldSet>
            <Field>
              <FieldLabel htmlFor="user-name">Name</FieldLabel>
              <Input
                id="user-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                disabled={isSaving}
                autoFocus
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="user-email">Email</FieldLabel>
              <Input id="user-email" value={user.email} disabled />
            </Field>
          </FieldSet>
          <Field orientation="horizontal">
            <Button type="submit" disabled={!name.trim() || name === user.name || isSaving}>
              {isSaving ? "Saving..." : "Save"}
            </Button>
          </Field>
        </FieldGroup>
      </form>

      <FieldGroup>
        <FieldSet>
          <Field>
            <FieldLabel htmlFor="theme">Theme</FieldLabel>
            <Select value={theme} onValueChange={setTheme}>
              <SelectTrigger id="theme">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="light">Light</SelectItem>
                <SelectItem value="dark">Dark</SelectItem>
                <SelectItem value="system">System</SelectItem>
              </SelectContent>
            </Select>
            <FieldDescription>Changes are saved automatically</FieldDescription>
          </Field>
        </FieldSet>
      </FieldGroup>
    </div>
  );
}

type Membership = {
  id: string;
  role: string;
  organization: {
    id: string;
    name: string;
    slug: string;
  };
};

function OrgMembershipCard({ membership }: { membership: Membership }) {
  const navigate = useNavigate();
  const [confirmLeaveOpen, setConfirmLeaveOpen] = useState(false);

  const leaveOrg = useMutation({
    mutationFn: async () => {
      return trpcClient.organization.leave.mutate({
        organizationSlug: membership.organization.slug,
      });
    },
    onSuccess: () => {
      toast.success(`Left ${membership.organization.name}`);
      setConfirmLeaveOpen(false);
      navigate({ to: "/" });
    },
    onError: (error) => {
      toast.error(error.message);
    },
  });

  return (
    <>
      <div className="flex items-center justify-between gap-4 p-4 border rounded-lg bg-card">
        <div className="min-w-0">
          <div className="font-medium truncate">{membership.organization.name}</div>
          <div className="text-sm text-muted-foreground">{membership.role}</div>
        </div>
        <Button size="sm" variant="outline" onClick={() => setConfirmLeaveOpen(true)}>
          <LogOut className="h-4 w-4" />
        </Button>
      </div>

      <Dialog open={confirmLeaveOpen} onOpenChange={setConfirmLeaveOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Leave {membership.organization.name}?</DialogTitle>
            <DialogDescription>
              You will lose access to all projects in this organization. You'll need a new invite to
              rejoin.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmLeaveOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => leaveOrg.mutate()}
              disabled={leaveOrg.isPending}
            >
              {leaveOrg.isPending ? "Leaving..." : "Leave"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
