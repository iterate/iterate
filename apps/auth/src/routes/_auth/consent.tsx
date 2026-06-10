import { Button } from "@iterate-com/ui/components/button";
import { Badge } from "@iterate-com/ui/components/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@iterate-com/ui/components/card";
import { Avatar, AvatarFallback, AvatarImage } from "@iterate-com/ui/components/avatar";
import { Separator } from "@iterate-com/ui/components/separator";
import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery } from "@tanstack/react-query";
import { z } from "zod/v4";
import { ITERATE_PROJECT_SELECTION_SCOPE } from "@iterate-com/shared/auth-claims";
import { authClient, useSession } from "../../utils/auth-client.ts";
import { oauthClientQueryOptions } from "../../utils/auth-query-options.ts";
import { getInitials } from "../../utils/initials.ts";

export const Route = createFileRoute("/_auth/consent")({
  component: RouteComponent,
  validateSearch: z.looseObject({
    client_id: z.string(),
    scope: z.string(),
  }),
});

function RouteComponent() {
  const { client_id, scope } = Route.useSearch();
  const navigate = Route.useNavigate();
  const session = useSession();
  const requestedScopes = scope.split(" ").filter(Boolean);

  const oauthClientQuery = useQuery(oauthClientQueryOptions(client_id));

  const consentMutation = useMutation({
    mutationFn: async ({ accept }: { accept: boolean }) => {
      const result = await authClient.oauth2.consent({ accept });
      if (!result.url) {
        throw new Error("Could not continue the OAuth redirect");
      }

      window.location.href = result.url;
      return result;
    },
  });

  const switchAccount = useMutation({
    mutationFn: () => authClient.signOut(),
    onSuccess: () => {
      const returnURL = window.location.pathname + window.location.search;
      navigate({ to: "/login", search: { redirect: returnURL } });
    },
  });

  if (oauthClientQuery.isPending) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-muted/20 p-4">
        <Card className="w-full max-w-md">
          <CardHeader>
            <div className="h-12 w-12 rounded-lg bg-muted" />
            <div className="h-5 w-40 rounded bg-muted" />
            <div className="h-4 w-64 max-w-full rounded bg-muted" />
          </CardHeader>
          <Separator />
          <CardContent className="space-y-3">
            <div className="h-14 rounded-lg bg-muted" />
            <div className="h-20 rounded-lg bg-muted" />
          </CardContent>
        </Card>
      </div>
    );
  }

  if (oauthClientQuery.isError) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-muted/20 p-4">
        <Card className="w-full max-w-md">
          <CardHeader>
            <CardTitle className="text-xl">Something went wrong</CardTitle>
            <CardDescription>{oauthClientQuery.error.message}</CardDescription>
          </CardHeader>
        </Card>
      </div>
    );
  }

  const client = oauthClientQuery.data;
  const user = session.user;
  const initials = getInitials(user.name ?? user.email);
  const clientName = client?.client_name ?? "This application";

  return (
    <div className="flex min-h-screen items-center justify-center bg-muted/20 p-4">
      <Card className="w-full max-w-md">
        <CardHeader className="gap-4">
          <div className="flex items-center gap-3">
            <ClientMark logoUri={client?.logo_uri} name={clientName} />
            <div className="min-w-0">
              <Badge variant="outline">Account access</Badge>
              <CardTitle className="mt-2 text-xl">Allow {clientName}?</CardTitle>
            </div>
          </div>
          <CardDescription>{clientName} wants to use your Iterate account.</CardDescription>
        </CardHeader>
        <Separator />
        <CardContent>
          <div className="flex items-center justify-between gap-3 rounded-lg border bg-muted/30 p-3">
            <div className="flex min-w-0 items-center gap-3">
              <Avatar>
                {user.image && <AvatarImage src={user.image} alt={user.name ?? user.email} />}
                <AvatarFallback>{initials}</AvatarFallback>
              </Avatar>
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{user.name ?? "User"}</p>
                <p className="truncate text-xs text-muted-foreground">{user.email}</p>
              </div>
            </div>
            <Button
              variant="ghost"
              size="sm"
              disabled={switchAccount.isPending}
              onClick={() => switchAccount.mutate()}
            >
              {switchAccount.isPending ? "Switching..." : "Switch"}
            </Button>
          </div>
        </CardContent>
        {requestedScopes.length > 0 && (
          <>
            <Separator />
            <CardContent className="space-y-3">
              <div>
                <p className="text-sm font-medium">Access requested</p>
                <p className="text-xs text-muted-foreground">Review what {clientName} can use.</p>
              </div>
              <ul className="space-y-2">
                {requestedScopes.map((requestedScope: string) => (
                  <li key={requestedScope} className="rounded-lg border p-3">
                    <p className="text-sm font-medium">{scopeLabel(requestedScope)}</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {scopeDescription(requestedScope)}
                    </p>
                  </li>
                ))}
              </ul>
            </CardContent>
          </>
        )}
        {consentMutation.isError ? (
          <>
            <Separator />
            <CardContent>
              <p className="text-sm text-destructive">{consentMutation.error.message}</p>
            </CardContent>
          </>
        ) : null}
        <Separator />
        <CardFooter className="gap-3">
          <Button
            className="flex-1"
            variant="outline"
            disabled={consentMutation.isPending}
            onClick={() => consentMutation.mutate({ accept: false })}
          >
            Deny
          </Button>
          <Button
            className="flex-1"
            disabled={consentMutation.isPending}
            onClick={() => consentMutation.mutate({ accept: true })}
          >
            {consentMutation.isPending ? "Authorizing..." : "Allow access"}
          </Button>
        </CardFooter>
      </Card>
    </div>
  );
}

function ClientMark(props: { logoUri?: string | null; name: string }) {
  if (props.logoUri) {
    return <img src={props.logoUri} alt="" className="size-12 shrink-0 rounded-lg border" />;
  }

  return (
    <div className="flex size-12 shrink-0 items-center justify-center rounded-lg border bg-muted text-sm font-semibold">
      {getInitials(props.name)}
    </div>
  );
}

function scopeLabel(scope: string): string {
  const labels: Record<string, string> = {
    openid: "Confirm your identity",
    profile: "View your profile",
    email: "View your email",
    offline_access: "Stay connected",
    [ITERATE_PROJECT_SELECTION_SCOPE]: "Use selected projects",
  };

  return labels[scope] ?? scope;
}

function scopeDescription(scope: string): string {
  const descriptions: Record<string, string> = {
    openid: "Know which Iterate account is signed in.",
    profile: "Read your display name and profile image.",
    email: "Read the email address on this account.",
    offline_access: "Continue working after this browser session.",
    [ITERATE_PROJECT_SELECTION_SCOPE]: "Access only the projects you chose.",
  };

  return descriptions[scope] ?? "Use this requested permission.";
}
