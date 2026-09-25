// /organizations/<organization> — its settings: the name (renamed here, by an owner), the id, its
// projects, its members (removed here, by an owner), its invitation links (an owner creates one to
// copy and send, and revokes the ones still open — the person who opens it joins on
// /invitations/<token>), billing (nothing to bill yet), and the danger zone — delete, once it holds
// no project. Everything shown is the tree's
// (components/organization-tree.tsx): the organization's own live state, the person's role from
// the account's memberships — a rename, a membership, a project lands here without a reload. An
// organization the tree does not hold is not found.
import { useEffect, useState, type FormEvent } from "react";
import { createFileRoute, getRouteApi, Link, notFound, useNavigate } from "@tanstack/react-router";
import { Check, Copy, Link2, UserMinus, X } from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@iterate-com/ui/components/alert-dialog";
import { Badge } from "@iterate-com/ui/components/badge";
import { Button } from "@iterate-com/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@iterate-com/ui/components/card";
import { Field, FieldLabel } from "@iterate-com/ui/components/field";
import { Input } from "@iterate-com/ui/components/input";
import { NativeSelect, NativeSelectOption } from "@iterate-com/ui/components/native-select";
import { NotRecorded } from "@iterate-com/ui/components/not-recorded";
import { DefaultPendingComponent } from "@iterate-com/ui/components/route-defaults";
import { Spinner } from "@iterate-com/ui/components/spinner";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@iterate-com/ui/components/table";
import { Identifier } from "../../../components/identifier.tsx";
import { AllowOrganizations } from "../../../components/allow-organizations.tsx";
import {
  readOrganizationTree,
  reloadOrganizationTree,
  useOrganizationTree,
  useOrganizationTreeEntry,
  type OrganizationRole,
  type TreeOrganization,
} from "../../../components/organization-tree.tsx";

const shell = getRouteApi("/_auth");

export const Route = createFileRoute("/_auth/organizations/$orgId")({
  // the name when the tree already has it (a navigation within the shell), else the id
  head: ({ params }) => ({
    meta: [
      {
        title: `${
          readOrganizationTree().organizations.find((org) => org.id === params.orgId)?.name ||
          params.orgId
        } · Dash`,
      },
    ],
  }),
  component: OrganizationPage,
});

/** One organization per mount: the tree moves between organizations on this route, so each starts
 *  with its own form, errors and leaving flag. */
function OrganizationPage() {
  const { orgId } = Route.useParams();
  return <OrganizationSettings key={orgId} orgId={orgId} />;
}

function OrganizationSettings({ orgId }: { orgId: string }) {
  const { org, missing } = useOrganizationTreeEntry(orgId);
  // a delete, or removing yourself, drops the membership from the tree before the verb answers:
  // the page is on its way to the list, not to not-found
  const [leaving, setLeaving] = useState(false);
  if (!org) {
    if (missing && !leaving) throw notFound();
    return <DefaultPendingComponent />;
  }
  return <OrganizationSettingsFor org={org} onLeaving={() => setLeaving(true)} />;
}

function OrganizationSettingsFor({
  org,
  onLeaving,
}: {
  org: TreeOrganization;
  onLeaving: () => void;
}) {
  const { api, info } = shell.useRouteContext();
  const tree = useOrganizationTree();
  const navigate = useNavigate();
  const canWrite = info.scopes.includes("organizations:write");
  const owner = org.role === "owner";
  // The name follows the organization's live state (the tree names it by id until that answers)
  // until the person starts editing; a save hands the field back to the live value.
  const [name, setName] = useState(org.name);
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    if (!editing) setName(org.name);
  }, [org.name, editing]);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function rename(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSaving(true);
    try {
      await api.organizations.rename(org.id, { name: name.trim() });
      reloadOrganizationTree(); // the listed tree's; the live one follows by itself
      setSaved(true);
      setEditing(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSaving(false);
    }
  }
  async function remove() {
    setError(null);
    setDeleting(true);
    onLeaving();
    try {
      await api.organizations.delete(org.id);
      reloadOrganizationTree();
      await navigate({ to: "/organizations", replace: true });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      setDeleting(false);
    }
  }
  const projectCount = org.projects.length;
  // the record's project list is only true once its live state has answered
  const counted = org.status === "live";
  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-8 p-4 md:p-8">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">{org.name}</h1>
        {org.role ? <Badge variant="secondary">{org.role}</Badge> : null}
        <Identifier value={org.id} />
        <Link
          to="/organizations/$orgId/activity"
          params={{ orgId: org.id }}
          className="text-sm text-muted-foreground underline-offset-2 hover:underline"
        >
          Activity
        </Link>
      </div>
      {error ? (
        <p role="alert" data-type="error" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {org.error ? (
        <p role="alert" data-type="error" className="text-sm text-destructive">
          The organization's record could not be read: {org.error}
        </p>
      ) : null}
      <form onSubmit={rename}>
        <Card>
          <CardHeader>
            <CardTitle>Name</CardTitle>
            <CardDescription>
              What the organization is called, everywhere it is listed.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Field>
              <FieldLabel htmlFor="organization-name">Organization name</FieldLabel>
              <Input
                id="organization-name"
                autoComplete="organization"
                value={name}
                disabled={!owner || !canWrite}
                onChange={(event) => {
                  setName(event.target.value);
                  setEditing(true);
                  setSaved(false);
                }}
                required
              />
            </Field>
            {canWrite ? null : <AllowOrganizations next={`/organizations/${org.id}`} />}
          </CardContent>
          <CardFooter className="gap-3">
            <Button
              type="submit"
              disabled={saving || !owner || !canWrite || !name.trim() || name.trim() === org.name}
            >
              {saving ? <Spinner data-icon="inline-start" /> : null}
              Save
            </Button>
            {saved ? (
              <span role="status" className="text-sm text-muted-foreground">
                Saved
              </span>
            ) : null}
            {owner ? null : (
              <span className="text-sm text-muted-foreground">Only an owner can rename it.</span>
            )}
          </CardFooter>
        </Card>
      </form>
      <Card>
        <CardHeader>
          <CardTitle>Projects</CardTitle>
          <CardDescription>
            {org.status === "connecting"
              ? "Reading the organization's record…"
              : projectCount
                ? `${projectCount} project${projectCount === 1 ? "" : "s"} in this organization.`
                : "No projects in this organization yet."}
          </CardDescription>
        </CardHeader>
        {projectCount ? (
          <CardContent className="flex flex-wrap gap-x-4 gap-y-2 font-mono text-sm">
            {org.projects.map((project) => (
              <Link
                key={project.id}
                to="/projects/$slug"
                params={{ slug: project.slug }}
                className="underline-offset-4 hover:underline"
              >
                {project.slug}
              </Link>
            ))}
          </CardContent>
        ) : null}
      </Card>
      <Members
        org={org}
        self={info.principal.actor}
        canManage={owner && canWrite}
        // the listed tree carries no members: the session cannot read the organization's record
        listed={tree.source === "listed"}
        onError={setError}
        onLeaving={onLeaving}
      />
      {owner && canWrite && tree.source === "live" ? (
        <Invitations org={org} onError={setError} />
      ) : null}
      <Card>
        <CardHeader>
          <CardTitle>Billing</CardTitle>
          <CardDescription>
            There is nothing to bill yet. The plan and the payment details will live here.
          </CardDescription>
        </CardHeader>
      </Card>
      <Card className="border-destructive/40">
        <CardHeader>
          <CardTitle>Delete organization</CardTitle>
          <CardDescription>
            {!counted
              ? "Reading the organization's projects…"
              : projectCount
                ? "An organization is deleted once it holds no project."
                : "Deletes the organization and its memberships. There is no undo."}
          </CardDescription>
        </CardHeader>
        <CardFooter>
          <AlertDialog>
            <AlertDialogTrigger
              render={<Button variant="destructive" />}
              disabled={deleting || !owner || !canWrite || !counted || projectCount > 0}
            >
              {deleting ? <Spinner data-icon="inline-start" /> : null}
              Delete organization
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Delete {org.name}?</AlertDialogTitle>
                <AlertDialogDescription>
                  The organization and its memberships go. There is no undo.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction onClick={() => void remove()}>Delete</AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </CardFooter>
      </Card>
    </div>
  );
}

/** Who belongs, from the organization's record — and, for an owner, remove one (people join by an
 *  invitation link: `<Invitations>`). The rows follow the record: a membership shows the moment
 *  its fact lands. */
function Members({
  org,
  self,
  canManage,
  listed,
  onError,
  onLeaving,
}: {
  org: TreeOrganization;
  /** the signed-in person's user id */
  self: string;
  canManage: boolean;
  listed: boolean;
  onError: (error: string | null) => void;
  /** removing yourself leaves the organization: the page goes back to the list */
  onLeaving: () => void;
}) {
  const { api } = shell.useRouteContext();
  const navigate = useNavigate();
  const [busy, setBusy] = useState<string | null>(null);
  const members = Object.entries(org.members).sort(
    ([idA, a], [idB, b]) => a.since.localeCompare(b.since) || idA.localeCompare(idB),
  );
  async function remove(memberId: string) {
    onError(null);
    setBusy(memberId);
    if (memberId === self) onLeaving();
    try {
      await api.organizations.removeMember(org.id, { userId: memberId });
      reloadOrganizationTree();
      if (memberId === self) await navigate({ to: "/organizations", replace: true });
    } catch (caught) {
      onError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(null);
    }
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle>Members</CardTitle>
        <CardDescription>
          {listed
            ? "This session does not read the organization's record; its members are not listed."
            : org.status === "connecting"
              ? "Reading the organization's record…"
              : `${members.length} member${members.length === 1 ? "" : "s"}. An owner runs the organization; a member reaches its projects.`}
        </CardDescription>
      </CardHeader>
      {members.length ? (
        <CardContent>
          <div className="overflow-x-auto rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>User</TableHead>
                  <TableHead>Role</TableHead>
                  <TableHead>Since</TableHead>
                  {canManage ? <TableHead className="w-0" /> : null}
                </TableRow>
              </TableHeader>
              <TableBody>
                {members.map(([memberId, membership]) => (
                  <TableRow key={memberId} data-testid="organization-member">
                    <TableCell>
                      <span className="flex flex-wrap items-center gap-2">
                        <Identifier value={memberId} textClassName="text-xs" />
                        {memberId === self ? <Badge variant="outline">you</Badge> : null}
                      </span>
                    </TableCell>
                    <TableCell className="text-muted-foreground">{membership.role}</TableCell>
                    <TableCell className="text-muted-foreground tabular-nums">
                      {new Date(membership.since).toLocaleDateString()}
                    </TableCell>
                    {canManage ? (
                      <TableCell className="text-right">
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          aria-label={`Remove ${memberId}`}
                          disabled={Boolean(busy)}
                          onClick={() => void remove(memberId)}
                        >
                          {busy === memberId ? <Spinner /> : <UserMinus />}
                        </Button>
                      </TableCell>
                    ) : null}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      ) : null}
    </Card>
  );
}

/** An owner's INVITATION LINKS: create one — a role, how long it stays open, and optionally who it
 *  is for (a note, never checked) — and copy it: it is shown this once (the platform keeps only its
 *  hash), so a lost link is revoked and made again. Below, the links still open, from the
 *  organization's record, each revocable; an accepted one leaves the list as its member joins the
 *  table above. */
function Invitations({
  org,
  onError,
}: {
  org: TreeOrganization;
  onError: (error: string | null) => void;
}) {
  const { api } = shell.useRouteContext();
  const [role, setRole] = useState<OrganizationRole>("member");
  const [expiresInDays, setExpiresInDays] = useState(7);
  const [emailHint, setEmailHint] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  // the link just created, shown until dismissed — or revoked, when it opens nothing any more
  const [created, setCreated] = useState<{
    id: string;
    link: string;
    emailHint: string | null;
  } | null>(null);
  const [copied, setCopied] = useState(false);
  const pending = Object.entries(org.invitations).sort(
    ([idA, a], [idB, b]) => a.createdAt.localeCompare(b.createdAt) || idA.localeCompare(idB),
  );
  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    onError(null);
    setBusy("create");
    try {
      const invitation = await api.organizations.createInvitation(org.id, {
        role,
        expiresInDays,
        emailHint: emailHint.trim() || undefined,
      });
      setCreated({
        id: invitation.id,
        link: new URL(`/invitations/${invitation.token}`, window.location.origin).href,
        emailHint: invitation.emailHint,
      });
      setCopied(false);
      setEmailHint("");
    } catch (caught) {
      onError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(null);
    }
  }
  async function copy(link: string) {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
    } catch (caught) {
      onError(caught instanceof Error ? caught.message : String(caught));
    }
  }
  async function revoke(invitationId: string) {
    onError(null);
    setBusy(invitationId);
    try {
      await api.organizations.revokeInvitation(org.id, { invitationId });
      setCreated((shown) => (shown?.id === invitationId ? null : shown));
    } catch (caught) {
      onError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(null);
    }
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle>Invite people</CardTitle>
        <CardDescription>
          Create a link and send it. The first person to open it and sign in joins with the role you
          pick. Each link works once.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-6">
        <form onSubmit={create} className="flex w-full flex-wrap items-end gap-3">
          <Field className="min-w-56 flex-1">
            <FieldLabel htmlFor="invitation-email-hint">For (optional)</FieldLabel>
            <Input
              id="invitation-email-hint"
              type="email"
              placeholder="name@example.com"
              autoComplete="off"
              value={emailHint}
              onChange={(event) => setEmailHint(event.target.value)}
            />
          </Field>
          <Field className="w-32">
            <FieldLabel htmlFor="invitation-role">Role</FieldLabel>
            <NativeSelect
              id="invitation-role"
              className="w-full"
              value={role}
              onChange={(event) => setRole(event.target.value as OrganizationRole)}
            >
              <NativeSelectOption value="member">member</NativeSelectOption>
              <NativeSelectOption value="owner">owner</NativeSelectOption>
            </NativeSelect>
          </Field>
          <Field className="w-36">
            <FieldLabel htmlFor="invitation-expiry">Expires in</FieldLabel>
            <NativeSelect
              id="invitation-expiry"
              className="w-full"
              value={String(expiresInDays)}
              onChange={(event) => setExpiresInDays(Number(event.target.value))}
            >
              <NativeSelectOption value="1">1 day</NativeSelectOption>
              <NativeSelectOption value="7">7 days</NativeSelectOption>
              <NativeSelectOption value="30">30 days</NativeSelectOption>
            </NativeSelect>
          </Field>
          <Button type="submit" disabled={Boolean(busy)}>
            {busy === "create" ? (
              <Spinner data-icon="inline-start" />
            ) : (
              <Link2 data-icon="inline-start" />
            )}
            Create invite link
          </Button>
        </form>
        {created ? (
          // never in a session replay or autocapture: the link joins the organization, shown once
          <NotRecorded
            role="status"
            data-testid="invitation-link"
            className="flex flex-col gap-2 rounded-md border bg-muted/40 p-3 text-sm"
          >
            <span>
              Copy this link now{created.emailHint ? ` and send it to ${created.emailHint}` : ""}.
              It is not shown again.
            </span>
            <div className="flex flex-wrap items-center gap-2">
              <Input
                readOnly
                aria-label="Invite link"
                className="min-w-0 flex-1 font-mono text-xs"
                value={created.link}
                onFocus={(event) => event.currentTarget.select()}
              />
              <Button type="button" size="sm" onClick={() => void copy(created.link)}>
                {copied ? <Check data-icon="inline-start" /> : <Copy data-icon="inline-start" />}
                {copied ? "Copied" : "Copy link"}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                aria-label="Dismiss"
                onClick={() => setCreated(null)}
              >
                <X />
              </Button>
            </div>
          </NotRecorded>
        ) : null}
        {pending.length ? (
          <div className="overflow-x-auto rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>For</TableHead>
                  <TableHead>Role</TableHead>
                  <TableHead>Expires</TableHead>
                  <TableHead className="w-0" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {pending.map(([invitationId, invitation]) => (
                  <TableRow key={invitationId} data-testid="organization-invitation">
                    <TableCell>
                      {invitation.emailHint || (
                        <span className="text-muted-foreground">Anyone with the link</span>
                      )}
                    </TableCell>
                    <TableCell className="text-muted-foreground">{invitation.role}</TableCell>
                    <TableCell className="text-muted-foreground tabular-nums">
                      {Date.parse(invitation.expiresAt) <= Date.now() ? (
                        <Badge variant="outline">expired</Badge>
                      ) : (
                        new Date(invitation.expiresAt).toLocaleDateString()
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        disabled={Boolean(busy)}
                        onClick={() => void revoke(invitationId)}
                      >
                        {busy === invitationId ? <Spinner data-icon="inline-start" /> : null}
                        Revoke
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">No open invite links.</p>
        )}
      </CardContent>
    </Card>
  );
}
