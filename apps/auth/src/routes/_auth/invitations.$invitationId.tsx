import { Button } from "@iterate-com/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@iterate-com/ui/components/card";
import { Separator } from "@iterate-com/ui/components/separator";
import { toast } from "@iterate-com/ui/components/sonner";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod/v4";
import { authClient, useSession } from "../../utils/auth-client.ts";
import { inventoryQueryOptions } from "./-projects-data.ts";

export const Route = createFileRoute("/_auth/invitations/$invitationId")({
  validateSearch: z.object({
    organization: z.string().optional().catch(undefined),
  }),
  component: InvitationPage,
});

function InvitationPage() {
  const { invitationId } = Route.useParams();
  const { organization } = Route.useSearch();
  const navigate = Route.useNavigate();
  const queryClient = useQueryClient();
  const session = useSession();
  const signedInEmail = session.user.email ?? "";
  const currentInvitationQueryKey = ["better-auth", "invitation", invitationId] as const;

  const invitationQuery = useQuery({
    queryKey: currentInvitationQueryKey,
    queryFn: () => authClient.organization.getInvitation({ query: { id: invitationId } }),
    retry: false,
  });

  const navigateToProjects = async (organizationSlug?: string) => {
    const targetOrganizationSlug = organizationSlug ?? organization;
    await navigate({
      to: "/projects/{-$organizationSlug}",
      params: targetOrganizationSlug ? { organizationSlug: targetOrganizationSlug } : {},
    });
  };

  const acceptInvitation = useMutation({
    mutationFn: () => authClient.organization.acceptInvitation({ invitationId }),
    onSuccess: async () => {
      toast.success("Invitation accepted");
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: currentInvitationQueryKey }),
        queryClient.invalidateQueries({ queryKey: inventoryQueryOptions().queryKey }),
      ]);
      await navigateToProjects(invitationQuery.data?.organizationSlug);
    },
    onError: (error) => toast.error(error.message),
  });

  const rejectInvitation = useMutation({
    mutationFn: () => authClient.organization.rejectInvitation({ invitationId }),
    onSuccess: async () => {
      toast.success("Invitation declined");
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: currentInvitationQueryKey }),
        queryClient.invalidateQueries({ queryKey: inventoryQueryOptions().queryKey }),
      ]);
      await navigateToProjects();
    },
    onError: (error) => toast.error(error.message),
  });

  const switchAccount = useMutation({
    mutationFn: () => authClient.signOut(),
    onSuccess: async () => {
      queryClient.clear();
      const returnURL = window.location.pathname + window.location.search;
      await navigate({ to: "/login", search: { redirect: returnURL } });
    },
    onError: (error) => toast.error(error.message),
  });

  if (invitationQuery.isPending) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-background p-4">
        <Card className="w-full max-w-md">
          <CardHeader>
            <CardTitle>Loading invitation</CardTitle>
            <CardDescription>Checking the invitation details.</CardDescription>
          </CardHeader>
        </Card>
      </main>
    );
  }

  if (invitationQuery.isError) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-background p-4">
        <Card className="w-full max-w-md">
          <CardHeader>
            <CardTitle>Invitation unavailable</CardTitle>
            <CardDescription>{invitationQuery.error.message}</CardDescription>
          </CardHeader>
          <Separator />
          <CardContent>
            <SignedInAccountRow
              email={signedInEmail}
              isSwitching={switchAccount.isPending}
              onSwitch={() => switchAccount.mutate()}
            />
          </CardContent>
          <CardFooter>
            <Button variant="outline" onClick={() => navigateToProjects()}>
              Back to organizations
            </Button>
          </CardFooter>
        </Card>
      </main>
    );
  }

  const invitation = invitationQuery.data;
  const isPendingInvitation = invitation.status === "pending";
  const signedInAsInvitedEmail =
    Boolean(signedInEmail) && invitation.email.toLowerCase() === signedInEmail.toLowerCase();
  const canRespond =
    isPendingInvitation &&
    signedInAsInvitedEmail &&
    !acceptInvitation.isPending &&
    !rejectInvitation.isPending &&
    !switchAccount.isPending;

  return (
    <main className="flex min-h-screen items-center justify-center bg-background p-4">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>Join {invitation.organizationName}</CardTitle>
          <CardDescription>
            {invitation.inviterEmail} invited {invitation.email} as {invitation.role}.
          </CardDescription>
        </CardHeader>
        <Separator />
        <CardContent className="space-y-3">
          <SignedInAccountRow
            email={signedInEmail}
            isSwitching={switchAccount.isPending}
            onSwitch={() => switchAccount.mutate()}
          />
          <div className="flex items-center justify-between gap-4 text-sm">
            <span className="text-muted-foreground">Status</span>
            <span className="font-medium">{invitation.status}</span>
          </div>
          <div className="flex items-center justify-between gap-4 text-sm">
            <span className="text-muted-foreground">Organization</span>
            <span className="truncate font-medium">{invitation.organizationSlug}</span>
          </div>
          {signedInAsInvitedEmail ? null : (
            <p className="text-sm text-destructive">
              Sign in as {invitation.email} to accept or decline this invitation.
            </p>
          )}
        </CardContent>
        <CardFooter className="justify-end gap-2">
          <Button
            variant="outline"
            disabled={!canRespond}
            onClick={() => rejectInvitation.mutate()}
          >
            {rejectInvitation.isPending ? "Declining..." : "Decline"}
          </Button>
          <Button disabled={!canRespond} onClick={() => acceptInvitation.mutate()}>
            {acceptInvitation.isPending ? "Accepting..." : "Accept"}
          </Button>
        </CardFooter>
      </Card>
    </main>
  );
}

function SignedInAccountRow(props: { email: string; isSwitching: boolean; onSwitch: () => void }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-md border bg-muted/30 px-3 py-2">
      <div className="min-w-0">
        <p className="text-xs text-muted-foreground">Signed in as</p>
        <p className="truncate text-sm font-medium">{props.email || "Unknown email"}</p>
      </div>
      <Button variant="ghost" size="sm" disabled={props.isSwitching} onClick={props.onSwitch}>
        {props.isSwitching ? "Switching..." : "Switch"}
      </Button>
    </div>
  );
}
