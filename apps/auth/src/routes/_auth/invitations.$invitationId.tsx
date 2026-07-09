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
import { authClient } from "../../utils/auth-client.ts";
import { inventoryQueryOptions } from "./-projects-shared.tsx";

export const Route = createFileRoute("/_auth/invitations/$invitationId")({
  component: InvitationPage,
});

function InvitationPage() {
  const { invitationId } = Route.useParams();
  const navigate = Route.useNavigate();
  const queryClient = useQueryClient();

  const invitationQuery = useQuery({
    queryKey: ["better-auth", "invitation", invitationId] as const,
    queryFn: () => authClient.organization.getInvitation({ query: { id: invitationId } }),
    retry: false,
  });

  const navigateToProjects = async (organizationSlug?: string) => {
    await navigate({
      to: "/projects/{-$organizationSlug}",
      params: organizationSlug ? { organizationSlug } : {},
    });
  };

  const acceptInvitation = useMutation({
    mutationFn: () => authClient.organization.acceptInvitation({ invitationId }),
    onSuccess: async () => {
      toast.success("Invitation accepted");
      await queryClient.invalidateQueries({ queryKey: inventoryQueryOptions().queryKey });
      await navigateToProjects(invitationQuery.data?.organizationSlug);
    },
    onError: (error) => toast.error(error.message),
  });

  const rejectInvitation = useMutation({
    mutationFn: () => authClient.organization.rejectInvitation({ invitationId }),
    onSuccess: async () => {
      toast.success("Invitation declined");
      await navigateToProjects();
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
          <div className="flex items-center justify-between gap-4 text-sm">
            <span className="text-muted-foreground">Status</span>
            <span className="font-medium">{invitation.status}</span>
          </div>
          <div className="flex items-center justify-between gap-4 text-sm">
            <span className="text-muted-foreground">Organization</span>
            <span className="truncate font-medium">{invitation.organizationSlug}</span>
          </div>
        </CardContent>
        <CardFooter className="justify-end gap-2">
          <Button
            variant="outline"
            disabled={
              !isPendingInvitation || rejectInvitation.isPending || acceptInvitation.isPending
            }
            onClick={() => rejectInvitation.mutate()}
          >
            {rejectInvitation.isPending ? "Declining..." : "Decline"}
          </Button>
          <Button
            disabled={
              !isPendingInvitation || acceptInvitation.isPending || rejectInvitation.isPending
            }
            onClick={() => acceptInvitation.mutate()}
          >
            {acceptInvitation.isPending ? "Accepting..." : "Accept"}
          </Button>
        </CardFooter>
      </Card>
    </main>
  );
}
