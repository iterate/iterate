import { Button } from "@iterate-com/ui/components/button";
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
import { authClient, useSession } from "../../utils/auth-client.ts";
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

  const oauthClientQuery = useQuery({
    queryKey: ["better-auth", "oauth2", "client", client_id],
    queryFn: () =>
      authClient.oauth2.publicClient({
        query: { client_id },
      }),
  });

  const consentMutation = useMutation({
    mutationFn: ({ accept }: { accept: boolean }) => authClient.oauth2.consent({ accept, scope }),
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
      <div className="flex min-h-screen items-center justify-center">
        <p className="text-sm text-muted-foreground">Loading...</p>
      </div>
    );
  }

  if (oauthClientQuery.isError) {
    return (
      <div className="flex min-h-screen items-center justify-center p-4">
        <Card className="w-full max-w-sm">
          <CardHeader className="text-center">
            <CardTitle className="text-xl">Something went wrong</CardTitle>
            <CardDescription>{oauthClientQuery.error.message}</CardDescription>
          </CardHeader>
        </Card>
      </div>
    );
  }

  const client = oauthClientQuery.data;
  const scopes = scope.split(" ").filter(Boolean);
  const user = session.user;
  const initials = getInitials(user.name ?? user.email);

  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <Card className="w-full max-w-sm">
        <CardHeader className="text-center">
          {client?.logo_uri && (
            <img src={client.logo_uri} alt="" className="mx-auto size-12 rounded-lg" />
          )}
          <CardTitle className="text-xl">
            Authorize {client?.client_name ?? "application"}
          </CardTitle>
          <CardDescription className="text-xs">
            {client?.client_name ?? "An application"} is requesting access to your account
          </CardDescription>
        </CardHeader>
        <Separator />
        <CardContent>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3 min-w-0">
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
        {scopes.length > 0 && (
          <>
            <Separator />
            <CardContent className="space-y-2">
              <p className="text-sm font-medium">This will allow the application to:</p>
              <ul className="space-y-1.5">
                {scopes.map((s) => (
                  <li key={s} className="flex items-center gap-2 text-sm text-muted-foreground">
                    <span className="size-1.5 shrink-0 rounded-full bg-primary" />
                    {scopeLabel(s)}
                  </li>
                ))}
              </ul>
            </CardContent>
          </>
        )}
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
            {consentMutation.isPending ? "Authorizing..." : "Allow"}
          </Button>
        </CardFooter>
      </Card>
    </div>
  );
}

function scopeLabel(scope: string): string {
  const labels: Record<string, string> = {
    openid: "Verify your identity",
    profile: "View your profile information",
    email: "View your email address",
    offline_access: "Maintain access when you're not using the app",
  };
  return labels[scope] ?? scope;
}
