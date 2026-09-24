// /invitations/<token> — where an invitation link lands. The shell signs the person in first (the
// `_auth` route's `authenticate` sends a stranger through the issuer and back here, `next` being this
// URL), then the page shows what the link opens — the organization, the role, whether it can still
// be used (`organizations.invitation`) — and "Join" accepts it (`organizations.acceptInvitation`):
// the person becomes a member and lands on the organization's page. Single use: a link someone else
// already accepted, a revoked one and an expired one say so and join nothing.
import { useState, type ReactNode } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { UserPlus } from "lucide-react";
import { Badge } from "@iterate-com/ui/components/badge";
import { Button, buttonVariants } from "@iterate-com/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@iterate-com/ui/components/card";
import { Spinner } from "@iterate-com/ui/components/spinner";
import { AllowOrganizations } from "../../components/allow-organizations.tsx";
import { reloadOrganizationTree } from "../../components/organization-tree.tsx";

export const Route = createFileRoute("/_auth/invitations/$token")({
  staticData: { page: "Invitation" },
  // awaited here: the call is a capnweb RpcPromise, sent but only pulled once something awaits it —
  // returned bare, the router never did (seen on a preview: no pull, the page read "not valid")
  loader: async ({ context, params }) => await context.api.organizations.invitation(params.token),
  head: () => ({ meta: [{ title: "Invitation · Dash" }] }),
  component: InvitationPage,
});

function InvitationPage() {
  const invitation = Route.useLoaderData();
  const { token } = Route.useParams();
  const { api, info } = Route.useRouteContext();
  const navigate = useNavigate();
  const [joining, setJoining] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canWrite = info.scopes.includes("organizations:write");
  async function join() {
    setError(null);
    setJoining(true);
    try {
      const organization = await api.organizations.acceptInvitation(token);
      reloadOrganizationTree(); // the listed tree's; the live one follows the account by itself
      await navigate({ to: "/organizations/$orgId", params: { orgId: organization.id } });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      setJoining(false);
    }
  }
  if (!invitation)
    return (
      <Notice
        title="This invitation link is not valid"
        description="Check that the whole link was copied, or ask an owner of the organization for a new one."
      />
    );
  const open = (
    <Link
      to="/organizations/$orgId"
      params={{ orgId: invitation.orgId }}
      className={buttonVariants()}
    >
      Open {invitation.orgName}
    </Link>
  );
  if (invitation.member)
    return (
      <Notice
        title={`You belong to ${invitation.orgName}`}
        description="You are already a member of this organization."
        action={open}
      />
    );
  if (invitation.status !== "pending")
    return (
      <Notice
        title={
          invitation.status === "accepted"
            ? "This invitation was already used"
            : invitation.status === "revoked"
              ? "This invitation was revoked"
              : "This invitation has expired"
        }
        description={`Each link works once. Ask an owner of ${invitation.orgName} for a new one.`}
      />
    );
  return (
    <div className="mx-auto flex w-full max-w-xl flex-col gap-6 p-4 md:p-8">
      <Card>
        <CardHeader>
          <CardTitle className="text-xl">Join {invitation.orgName}</CardTitle>
          <CardDescription>
            You were invited to join this organization as {invitation.role === "owner" ? "an" : "a"}{" "}
            <Badge variant="secondary">{invitation.role}</Badge>. Link expires{" "}
            {new Date(invitation.expiresAt).toLocaleString()}.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 text-sm text-muted-foreground">
          {info.principal.email ? (
            <p>
              You will join as <span className="text-foreground">{info.principal.email}</span>.
            </p>
          ) : null}
          {canWrite ? null : <AllowOrganizations next={`/invitations/${token}`} />}
          {error ? (
            <p role="alert" data-type="error" className="text-destructive">
              {error}
            </p>
          ) : null}
        </CardContent>
        <CardFooter>
          <Button type="button" disabled={joining || !canWrite} onClick={() => void join()}>
            {joining ? <Spinner data-icon="inline-start" /> : <UserPlus data-icon="inline-start" />}
            Join {invitation.orgName}
          </Button>
        </CardFooter>
      </Card>
    </div>
  );
}

function Notice({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="mx-auto flex w-full max-w-xl flex-col gap-6 p-4 md:p-8">
      <Card>
        <CardHeader>
          <CardTitle className="text-xl">{title}</CardTitle>
          <CardDescription>{description}</CardDescription>
        </CardHeader>
        {action ? <CardFooter>{action}</CardFooter> : null}
      </Card>
    </div>
  );
}
