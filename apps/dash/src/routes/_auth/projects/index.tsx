// /projects — every project the session reaches, by organization, with a way to create one; the
// organization form when the grant holds `organizations:write`, a step-up link otherwise.
import { useState, type FormEvent } from "react";
import { createFileRoute, getRouteApi, Link, useRouter } from "@tanstack/react-router";
import { ArrowUpRight, Building2, Plus } from "lucide-react";
import { Button, buttonVariants } from "@iterate-com/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@iterate-com/ui/components/card";
import { Input } from "@iterate-com/ui/components/input";
import { NativeSelect, NativeSelectOption } from "@iterate-com/ui/components/native-select";
import { cn } from "@iterate-com/ui/lib/utils";
import { projectsByOrg } from "../../../lib/projects.ts";
import { projectHostOf } from "../../_auth.tsx";

const shell = getRouteApi("/_auth");

export const Route = createFileRoute("/_auth/projects/")({
  component: ProjectsPage,
});

function ProjectsPage() {
  const { orgs, projects } = shell.useLoaderData();
  const { info } = shell.useRouteContext();
  const groups = projectsByOrg(orgs, projects);
  const hostOf = (projectId: string) => projectHostOf(info, projectId);
  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-8 p-4 md:p-8">
      <h1 className="text-2xl font-semibold tracking-tight">Projects</h1>
      {groups.length ? (
        groups.map((group) => (
          <section key={group.org.id || "other"} className="flex flex-col gap-3">
            <h2 className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
              <Building2 className="size-4" />
              {group.org.name}
              {group.org.role ? (
                <span className="text-xs font-normal">({group.org.role})</span>
              ) : null}
            </h2>
            <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {group.projects.map((project) => (
                <li key={project.id}>
                  {/* relative: the title link stretches over THIS card, not the page */}
                  <Card size="sm" className="relative h-full transition-colors hover:bg-accent/50">
                    <CardHeader>
                      <CardTitle className="truncate font-mono text-sm">
                        <Link
                          to="/projects/$projectId"
                          params={{ projectId: project.id }}
                          className="after:absolute after:inset-0"
                        >
                          {project.id}
                        </Link>
                      </CardTitle>
                      <CardDescription className="flex items-center gap-2">
                        {hostOf(project.id) ? (
                          <a
                            href={hostOf(project.id)!}
                            target="_blank"
                            rel="noreferrer"
                            className="relative z-10 inline-flex items-center gap-1 hover:text-foreground"
                          >
                            open
                            <ArrowUpRight className="size-3" />
                          </a>
                        ) : null}
                      </CardDescription>
                    </CardHeader>
                  </Card>
                </li>
              ))}
            </ul>
          </section>
        ))
      ) : (
        <p className="text-sm text-muted-foreground">No projects yet — create the first below.</p>
      )}
      <div className="grid gap-4 md:grid-cols-2" id="new">
        <CreateProject orgs={orgs} />
        {info.scopes.includes("organizations:write") ? (
          <CreateOrganization />
        ) : (
          <AllowOrganizations />
        )}
      </div>
    </div>
  );
}

function CreateProject({ orgs }: { orgs: { id: string; name: string }[] }) {
  const { api } = shell.useRouteContext();
  const router = useRouter();
  const [name, setName] = useState("");
  const [orgId, setOrgId] = useState(orgs[0]?.id ?? "");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setPending(true);
    try {
      // no organization chosen (none to choose from): the platform picks the person's default
      using _created = await api.projects.create({
        project: name.trim(),
        orgId: orgId || undefined,
      });
      setName("");
      await router.invalidate();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setPending(false);
    }
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle>New project</CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={create} className="flex flex-col gap-3">
          <Input
            aria-label="New project"
            placeholder="new-project-slug"
            value={name}
            onChange={(event) => setName(event.target.value)}
            required
          />
          {orgs.length > 1 ? (
            <NativeSelect
              aria-label="Organization"
              value={orgId}
              onChange={(event) => setOrgId(event.target.value)}
            >
              {orgs.map((org) => (
                <NativeSelectOption key={org.id} value={org.id}>
                  {org.name}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          ) : null}
          <div>
            <Button type="submit" disabled={pending || !name.trim()}>
              <Plus />
              {pending ? "Creating…" : "Create project"}
            </Button>
          </div>
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
        </form>
      </CardContent>
    </Card>
  );
}

function CreateOrganization() {
  const { api } = shell.useRouteContext();
  const router = useRouter();
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setPending(true);
    try {
      await api.createOrg(name.trim());
      setName("");
      await router.invalidate();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setPending(false);
    }
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle>New organization</CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={create} className="flex flex-col gap-3">
          <Input
            id="organization-name"
            aria-label="Organization name"
            placeholder="Acme"
            value={name}
            onChange={(event) => setName(event.target.value)}
            required
          />
          <div>
            <Button type="submit" variant="outline" disabled={pending || !name.trim()}>
              <Building2 />
              {pending ? "Creating…" : "Create organization"}
            </Button>
          </div>
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
        </form>
      </CardContent>
    </Card>
  );
}

/** The dash asked for `organizations:write` and the person unticked it at consent: `/.auth/login`
 *  with the scope asked for again re-consents; the granted set is what `info.scopes` says. */
function AllowOrganizations() {
  const stepUp = `/.auth/login?${new URLSearchParams({
    next: "/projects",
    scope: "iterate account organizations:write",
  })}`;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Organizations</CardTitle>
        <CardDescription>This session may not create organizations.</CardDescription>
      </CardHeader>
      <CardContent>
        <a href={stepUp} className={cn(buttonVariants({ variant: "outline" }))}>
          Allow the dash to create organizations
        </a>
      </CardContent>
    </Card>
  );
}
