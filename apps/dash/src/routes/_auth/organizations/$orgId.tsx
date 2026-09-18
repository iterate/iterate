// /organizations/<organization> — its settings: the name (renamed here, by an owner), the id, its
// projects, billing (nothing to bill yet), and the danger zone — delete, once it holds no project.
// The organization is resolved from the session's list; one the session does not reach is not found.
import { useState, type FormEvent } from "react";
import {
  createFileRoute,
  getRouteApi,
  Link,
  notFound,
  useNavigate,
  useRouter,
} from "@tanstack/react-router";
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
import { Identifier } from "@iterate-com/ui/components/identifier";
import { Input } from "@iterate-com/ui/components/input";
import { Spinner } from "@iterate-com/ui/components/spinner";
import { AllowOrganizations } from "../../../components/allow-organizations.tsx";

const shell = getRouteApi("/_auth");

export const Route = createFileRoute("/_auth/organizations/$orgId")({
  beforeLoad: async ({ context, params }) => {
    const orgs = await context.api.orgs();
    const org = orgs.find((candidate) => candidate.id === params.orgId);
    if (!org) throw notFound();
    return { org };
  },
  component: OrganizationSettings,
});

function OrganizationSettings() {
  const { org, api, info } = Route.useRouteContext();
  const { projects } = shell.useLoaderData();
  const router = useRouter();
  const navigate = useNavigate();
  // the projects this session reaches in it, for the links; `org.projects` counts every one
  const reached = projects.filter((project) => project.orgId === org.id);
  const canWrite = info.scopes.includes("organizations:write");
  const owner = org.role === "owner";
  const [name, setName] = useState(org.name);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function rename(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSaving(true);
    try {
      await api.updateOrg(org.id, { name: name.trim() });
      await router.invalidate();
      setSaved(true);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSaving(false);
    }
  }
  async function remove() {
    setError(null);
    setDeleting(true);
    try {
      await api.deleteOrg(org.id);
      // leave first: reloading this route's matches would resolve the deleted organization to
      // not-found mid-reload; the list reloads once it is the page
      await navigate({ to: "/organizations", replace: true });
      await router.invalidate();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      setDeleting(false);
    }
  }
  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-8 p-4 md:p-8">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">{org.name}</h1>
        {org.role ? <Badge variant="secondary">{org.role}</Badge> : null}
        <Identifier value={org.id} />
      </div>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
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
            {org.projects
              ? `${org.projects} project${org.projects === 1 ? "" : "s"} in this organization${
                  reached.length < org.projects
                    ? `, ${reached.length} of them in this session's grant`
                    : ""
                }.`
              : "No projects in this organization yet."}
          </CardDescription>
        </CardHeader>
        {reached.length ? (
          <CardContent className="flex flex-wrap gap-x-4 gap-y-2 font-mono text-sm">
            {reached.map((project) => (
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
            {org.projects
              ? "An organization is deleted once it holds no project."
              : "Deletes the organization and its memberships. There is no undo."}
          </CardDescription>
        </CardHeader>
        <CardFooter>
          <AlertDialog>
            <AlertDialogTrigger
              render={<Button variant="destructive" />}
              disabled={deleting || !owner || !canWrite || org.projects > 0}
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
