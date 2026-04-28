import { Button } from "@iterate-com/ui/components/button";
import { Card, CardContent, CardHeader, CardTitle } from "@iterate-com/ui/components/card";
import { Avatar, AvatarFallback, AvatarImage } from "@iterate-com/ui/components/avatar";
import { Separator } from "@iterate-com/ui/components/separator";
import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { authClient, useSession } from "../../utils/auth-client.ts";
import { getInitials } from "../../utils/initials.ts";
import { InfoRow } from "../../utils/info-row.tsx";

export const Route = createFileRoute("/_auth/")({
  component: RouteComponent,
});

function RouteComponent() {
  const session = useSession();
  const navigate = Route.useNavigate();

  const signOut = useMutation({
    mutationFn: () => authClient.signOut(),
    onSuccess: () => {
      navigate({ to: "/login", reloadDocument: true });
    },
  });

  const user = session.user;
  const initials = getInitials(user.name ?? user.email);

  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <div className="w-full max-w-sm space-y-4">
        <Card>
          <CardHeader className="items-center justify-items-center text-center">
            <Avatar size="lg">
              {user.image && <AvatarImage src={user.image} alt={user.name ?? user.email} />}
              <AvatarFallback>{initials}</AvatarFallback>
            </Avatar>
            <CardTitle className="text-xl">{user.name ?? "User"}</CardTitle>
            <p className="text-sm text-muted-foreground">{user.email}</p>
          </CardHeader>
          <Separator />
          <CardContent className="space-y-3">
            <InfoRow label="Email verified" value={user.emailVerified ? "Yes" : "No"} />
            <InfoRow label="User ID" value={user.id} />
            <InfoRow label="Joined" value={new Date(user.createdAt).toLocaleDateString()} />
          </CardContent>
          <Separator />
          <CardContent>
            <Button
              className="w-full"
              variant="outline"
              disabled={signOut.isPending}
              onClick={() => signOut.mutate()}
            >
              {signOut.isPending ? "Signing out..." : "Sign out"}
            </Button>
          </CardContent>
        </Card>

        <AuthorizedApps />
      </div>
    </div>
  );
}

function AuthorizedApps() {
  const queryClient = useQueryClient();

  const consentsQuery = useQuery({
    queryKey: ["oauth2", "consents"],
    queryFn: () => authClient.oauth2.getConsents(),
  });

  const revokeConsent = useMutation({
    mutationFn: (id: string) => authClient.oauth2.deleteConsent({ id }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["oauth2", "consents"] });
    },
  });

  if (consentsQuery.isPending) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Authorized apps</CardTitle>
        </CardHeader>
        <Separator />
        <CardContent>
          <p className="text-sm text-muted-foreground">Loading...</p>
        </CardContent>
      </Card>
    );
  }

  const consents = consentsQuery.data ?? [];

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Authorized apps</CardTitle>
      </CardHeader>
      <Separator />
      <CardContent>
        {consents.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No apps have been authorized to access your account.
          </p>
        ) : (
          <div className="space-y-3">
            {consents.map((consent) => (
              <ConsentRow
                key={consent.id}
                consent={consent}
                onRevoke={() => revokeConsent.mutate(consent.id)}
                isRevoking={revokeConsent.isPending && revokeConsent.variables === consent.id}
              />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function ConsentRow({
  consent,
  onRevoke,
  isRevoking,
}: {
  consent: { id: string; clientId: string; scopes: string[]; createdAt: Date };
  onRevoke: () => void;
  isRevoking: boolean;
}) {
  const clientQuery = useQuery({
    queryKey: ["oauth2", "client", consent.clientId],
    queryFn: () => authClient.oauth2.publicClient({ query: { client_id: consent.clientId } }),
  });

  const clientName = clientQuery.data?.client_name ?? consent.clientId;
  const logoURI = clientQuery.data?.logo_uri;

  return (
    <div className="flex items-start justify-between gap-3">
      <div className="flex items-center gap-3 min-w-0">
        {logoURI ? (
          <img src={logoURI} alt="" className="size-8 shrink-0 rounded-md" />
        ) : (
          <div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-xs font-medium">
            {clientName.slice(0, 1).toUpperCase()}
          </div>
        )}
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">{clientName}</p>
          <p className="truncate text-xs text-muted-foreground">{consent.scopes.join(", ")}</p>
        </div>
      </div>
      <Button variant="ghost" size="sm" disabled={isRevoking} onClick={onRevoke}>
        {isRevoking ? "Revoking..." : "Revoke"}
      </Button>
    </div>
  );
}
