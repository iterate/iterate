// /projects — every project the session reaches, by organization, and the one way to make one: the
// "New project" sheet (`?new=1`, so the switcher and a shared link open it too). An organization is
// made with its first project — "New organization…" inside the sheet when the grant holds
// `organizations:write`, a step-up link in its place otherwise.
import { useState, type FormEvent } from "react";
import { createFileRoute, getRouteApi, Link, useNavigate, useRouter } from "@tanstack/react-router";
import { ArrowUpRight, Building2, Plus } from "lucide-react";
import { z } from "zod";
import { Button } from "@iterate-com/ui/components/button";
import { Card, CardDescription, CardHeader, CardTitle } from "@iterate-com/ui/components/card";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@iterate-com/ui/components/field";
import { Input } from "@iterate-com/ui/components/input";
import { NativeSelect, NativeSelectOption } from "@iterate-com/ui/components/native-select";
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@iterate-com/ui/components/sheet";
import { Spinner } from "@iterate-com/ui/components/spinner";
import { projectsByOrg, type Org } from "../../../lib/projects.ts";
import { projectHostOf } from "../../_auth.tsx";

const shell = getRouteApi("/_auth");

export const Route = createFileRoute("/_auth/projects/")({
  validateSearch: z.object({ new: z.literal(1).optional() }),
  component: ProjectsPage,
});

function ProjectsPage() {
  const { orgs, projects } = shell.useLoaderData();
  const { info } = shell.useRouteContext();
  const search = Route.useSearch();
  const navigate = useNavigate();
  const [pending, setPending] = useState(false);
  const groups = projectsByOrg(orgs, projects);
  const hostOf = (slug: string) => projectHostOf(info, slug);
  const closeSheet = () => navigate({ to: "/projects", search: {}, replace: true });
  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-8 p-4 md:p-8">
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-2xl font-semibold tracking-tight">Projects</h1>
        <Button onClick={() => navigate({ to: "/projects", search: { new: 1 } })}>
          <Plus data-icon="inline-start" />
          New project
        </Button>
      </div>
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
                          {project.slug}
                        </Link>
                      </CardTitle>
                      <CardDescription className="flex items-center gap-2">
                        {hostOf(project.slug) ? (
                          <a
                            href={hostOf(project.slug)!}
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
        <p className="text-sm text-muted-foreground">
          No projects yet — “New project” creates the first.
        </p>
      )}
      {/* apps/os's create-project sheet: the right edge, full width on a phone, dismiss refused
          while the create is in flight so Escape and the backdrop cannot race it */}
      <Sheet
        open={search.new === 1}
        onOpenChange={(open) => {
          if (open || pending) return;
          void closeSheet();
        }}
      >
        <SheetContent
          side="right"
          showCloseButton={!pending}
          className="overflow-y-auto data-[side=right]:sm:max-w-md"
        >
          <NewProjectForm
            orgs={orgs}
            canCreateOrg={info.scopes.includes("organizations:write")}
            pending={pending}
            setPending={setPending}
            onCreated={closeSheet}
          />
        </SheetContent>
      </Sheet>
    </div>
  );
}

/** The sheet's body — mounted with the sheet, so every opening starts blank. */
function NewProjectForm({
  orgs,
  canCreateOrg,
  pending,
  setPending,
  onCreated,
}: {
  orgs: Org[];
  canCreateOrg: boolean;
  pending: boolean;
  setPending: (pending: boolean) => void;
  onCreated: () => Promise<void>;
}) {
  const { api, info } = shell.useRouteContext();
  const router = useRouter();
  // the project's slug — its hostname's label (its id is minted): lowercased as typed, anything but
  // a-z, 0-9 and dashes becoming a dash (the platform slugs it the same way)
  const [name, setName] = useState("");
  const host = projectHostOf(info, name || "my-project");
  // the chosen organization's id; "new" — the select's last option — the one named below; "" when
  // there is none yet (the platform then makes the person's first, from their email)
  const [orgId, setOrgId] = useState(orgs[0]?.id ?? "");
  const [orgName, setOrgName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const creatingOrg = orgId === "new";
  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setPending(true);
    try {
      let chosenOrgId = orgId;
      if (creatingOrg) {
        const created = await api.createOrg(orgName.trim());
        // the new organization stays chosen for the rest of the sheet's life: a refused project
        // name, retried, lands in it rather than minting a second one (names are not unique). The
        // shell's loader lists it, so the select has its option.
        chosenOrgId = created.id;
        setOrgId(created.id);
        await router.invalidate();
      }
      using _created = await api.projects.create({
        project: name.trim(),
        orgId: chosenOrgId || undefined,
      });
      await router.invalidate();
      await onCreated();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setPending(false);
    }
  }
  return (
    <form onSubmit={create} className="flex h-full flex-col">
      <SheetHeader className="border-b">
        <SheetTitle>New project</SheetTitle>
        <SheetDescription>
          A project is a workspace of its own — its site, repos and agents.
        </SheetDescription>
      </SheetHeader>
      <FieldGroup className="flex-1 p-4">
        <Field>
          <FieldLabel htmlFor="project">Project slug</FieldLabel>
          <Input
            id="project"
            placeholder="my-project"
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            value={name}
            onChange={(event) =>
              setName(event.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "-"))
            }
            required
          />
          {host ? (
            <FieldDescription>Your project will be hosted at {new URL(host).host}</FieldDescription>
          ) : null}
        </Field>
        {orgs.length ? (
          <Field>
            <FieldLabel htmlFor="project-organization">Organization</FieldLabel>
            <NativeSelect
              id="project-organization"
              className="w-full"
              value={orgId}
              onChange={(event) => setOrgId(event.target.value)}
            >
              {orgs.map((org) => (
                <NativeSelectOption key={org.id} value={org.id}>
                  {org.name}
                </NativeSelectOption>
              ))}
              {canCreateOrg ? (
                <NativeSelectOption value="new">New organization…</NativeSelectOption>
              ) : null}
            </NativeSelect>
          </Field>
        ) : null}
        {creatingOrg ? (
          <Field>
            <FieldLabel htmlFor="organization-name">Organization name</FieldLabel>
            <Input
              id="organization-name"
              placeholder="Acme"
              autoComplete="organization"
              value={orgName}
              onChange={(event) => setOrgName(event.target.value)}
              required
            />
          </Field>
        ) : null}
        {canCreateOrg ? null : <AllowOrganizations />}
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
      </FieldGroup>
      <SheetFooter className="border-t sm:flex-row sm:justify-end">
        <SheetClose disabled={pending} render={<Button type="button" variant="outline" />}>
          Cancel
        </SheetClose>
        <Button
          type="submit"
          disabled={pending || !name.trim() || (creatingOrg && !orgName.trim())}
        >
          {pending ? <Spinner data-icon="inline-start" /> : <Plus data-icon="inline-start" />}
          Create project
        </Button>
      </SheetFooter>
    </form>
  );
}

/** The dash asked for `organizations:write` and the person unticked it at consent: `/.auth/login`
 *  with the scope asked for again re-consents and lands back in this sheet; the granted set is what
 *  `info.scopes` says. */
function AllowOrganizations() {
  const stepUp = `/.auth/login?${new URLSearchParams({
    next: "/projects?new=1",
    scope: "iterate account organizations:write",
  })}`;
  return (
    <p className="text-sm text-muted-foreground">
      This session may not create organizations.{" "}
      <a href={stepUp} className="underline underline-offset-4 hover:text-foreground">
        Allow the dash to create organizations
      </a>
    </p>
  );
}
