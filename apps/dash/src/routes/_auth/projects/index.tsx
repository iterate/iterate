// /projects — every project in the tree (components/organization-tree.tsx, live), a table (the
// slug → its overview, the id, its organization → its settings, its site) in the organizations
// page's layout, and the one way to make one: the "New project" sheet (`?new=1`, so the switcher
// and a shared link open it too; `&template=` opens it with a template chosen, which is what a PR
// preview's quick-launch links are) — "New organization…" inside it when the grant holds
// `organizations:write`, a step-up link in its place otherwise. A created project's page is where
// the sheet leads: `projects.create` returns once the control plane answered, the organization's
// record lists the project the moment its fact lands, and that page renders the creation's progress live.
import { useState, type FormEvent } from "react";
import { createFileRoute, getRouteApi, Link, useNavigate } from "@tanstack/react-router";
import { ArrowUpRight, Plus } from "lucide-react";
import { z } from "zod";
import { parseConfigRepoTemplateReference } from "@iterate-com/shared/config-repo-template/reference";
import { Button } from "@iterate-com/ui/components/button";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@iterate-com/ui/components/field";
import { Identifier } from "@iterate-com/ui/components/identifier";
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@iterate-com/ui/components/table";
import { AllowOrganizations } from "../../../components/allow-organizations.tsx";
import { ListPage } from "../../../components/list-page.tsx";
import {
  reloadOrganizationTree,
  useOrganizationTree,
} from "../../../components/organization-tree.tsx";
import { projectHostOf } from "../../../lib/origins.ts";

const shell = getRouteApi("/_auth");

export const Route = createFileRoute("/_auth/projects/")({
  validateSearch: z.object({
    new: z.literal(1).optional().catch(undefined),
    // a `configs/` template by name (`with-agents`), or a `github:` reference for the custom field
    template: z.string().optional().catch(undefined),
  }),
  loader: async ({ context }) => ({ templateOptions: await context.api.projects.templates() }),
  head: () => ({ meta: [{ title: "Projects · Dash" }] }),
  component: ProjectsPage,
});

function ProjectsPage() {
  const tree = useOrganizationTree();
  const { info } = shell.useRouteContext();
  const search = Route.useSearch();
  const navigate = useNavigate();
  const [pending, setPending] = useState(false);
  return (
    <>
      <ListPage
        title="Projects"
        action={
          <Button onClick={() => navigate({ to: "/projects", search: { new: 1 } })}>
            <Plus data-icon="inline-start" />
            New project
          </Button>
        }
        empty={
          tree.projects.length ? undefined : tree.loaded ? (
            tree.error || "No projects yet — “New project” creates the first."
          ) : (
            <span className="flex items-center gap-2">
              <Spinner /> Loading your projects…
            </span>
          )
        }
      >
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Project</TableHead>
              <TableHead>Id</TableHead>
              <TableHead>Organization</TableHead>
              <TableHead>Site</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {tree.organizations.flatMap((org) =>
              org.projects.map((project) => {
                const host = projectHostOf(info, project.slug);
                return (
                  <TableRow key={project.id}>
                    <TableCell className="font-mono font-medium">
                      <Link
                        to="/projects/$slug"
                        params={{ slug: project.slug }}
                        className="underline-offset-4 hover:underline"
                      >
                        {project.slug}
                      </Link>
                    </TableCell>
                    <TableCell>
                      <Identifier value={project.id} textClassName="text-xs" />
                    </TableCell>
                    <TableCell>
                      <Link
                        to="/organizations/$orgId"
                        params={{ orgId: org.id }}
                        className="underline-offset-4 hover:underline"
                      >
                        {org.name}
                      </Link>
                    </TableCell>
                    <TableCell>
                      {host ? (
                        <a
                          href={host}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground"
                        >
                          {new URL(host).host}
                          <ArrowUpRight className="size-3" />
                        </a>
                      ) : null}
                    </TableCell>
                  </TableRow>
                );
              }),
            )}
          </TableBody>
        </Table>
      </ListPage>
      {/* The create-project sheet: the right edge, full width on a phone, dismiss refused
          while the create is in flight so Escape and the backdrop cannot race it */}
      <Sheet
        open={search.new === 1}
        onOpenChange={(open) => {
          if (open || pending) return;
          void navigate({ to: "/projects", search: {}, replace: true });
        }}
      >
        <SheetContent
          side="right"
          showCloseButton={!pending}
          className="overflow-y-auto data-[side=right]:sm:max-w-md"
        >
          <NewProjectForm
            initialTemplate={search.template}
            orgs={tree.organizations}
            canCreateOrg={info.scopes.includes("organizations:write")}
            pending={pending}
            setPending={setPending}
            // the new project's overview — leaving /projects closes the sheet with the page
            onCreated={(project) => navigate({ to: "/projects/$slug", params: { slug: project } })}
          />
        </SheetContent>
      </Sheet>
    </>
  );
}

/** The sheet's body — mounted with the sheet, so every opening starts blank, but for the template
 *  the URL names. */
function NewProjectForm({
  initialTemplate,
  orgs,
  canCreateOrg,
  pending,
  setPending,
  onCreated,
}: {
  /** `?template=`: a `configs/` template's name, or a `github:` reference */
  initialTemplate: string | undefined;
  /** the tree's organizations — the first is the default; may still be filling in */
  orgs: { id: string; name: string }[];
  canCreateOrg: boolean;
  pending: boolean;
  setPending: (pending: boolean) => void;
  /** The project is made: its slug (its id, where the platform answers none — the URL takes either). */
  onCreated: (project: string) => Promise<void>;
}) {
  const { api, info } = shell.useRouteContext();
  const { templateOptions } = Route.useLoaderData();
  // the project's slug — its hostname's label (its id is minted): lowercased as typed, anything but
  // a-z, 0-9 and dashes becoming a dash (the platform slugs it the same way)
  const [name, setName] = useState("");
  const host = projectHostOf(info, name || "my-project");
  // the chosen organization's id — the first in the tree until the person picks one (the tree may
  // land after the sheet opened); "new" — the select's last option — the one named below; "" when
  // there is none yet (the platform then makes the person's first, from their email)
  const [picked, setPicked] = useState<string | null>(null);
  const orgId = picked || orgs[0]?.id || "";
  const [orgName, setOrgName] = useState("");
  const initial = templateFields(initialTemplate, templateOptions);
  const [template, setTemplate] = useState(initial.template);
  const [customTemplate, setCustomTemplate] = useState(initial.customTemplate);
  const [error, setError] = useState<string | null>(null);
  const creatingOrg = orgId === "new";
  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setPending(true);
    try {
      let chosenOrgId = orgId;
      if (creatingOrg) {
        const created = await api.organizations.create({ name: orgName.trim() });
        // the new organization stays chosen for the rest of the sheet's life: a refused project
        // name, retried, lands in it rather than minting a second one (names are not unique). The
        // tree lists it as its membership lands, so the select has its option.
        chosenOrgId = created.id;
        setPicked(created.id);
        reloadOrganizationTree();
      }
      using created = await api.projects.create({
        project: name.trim(),
        orgId: chosenOrgId || undefined,
        configRepoTemplate: (template === "custom" ? customTemplate.trim() : template) || undefined,
      });
      // the slug as the platform slugged it, off the root context handed back
      const { projectId, projectSlug } = await created.whoami();
      reloadOrganizationTree();
      await onCreated(projectSlug || projectId);
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
          A project has its own site, repositories and installed apps.
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
        <Field>
          <FieldLabel htmlFor="project-template">Template</FieldLabel>
          <NativeSelect
            id="project-template"
            className="w-full"
            value={template}
            onChange={(event) => setTemplate(event.target.value)}
          >
            <NativeSelectOption value="">Minimal</NativeSelectOption>
            {templateOptions.map((option) => (
              <NativeSelectOption key={option.reference} value={option.reference}>
                {option.label}
              </NativeSelectOption>
            ))}
            <NativeSelectOption value="custom">Custom GitHub template…</NativeSelectOption>
          </NativeSelect>
          <FieldDescription>
            The template is copied into your project's config repository.
          </FieldDescription>
        </Field>
        {template === "custom" ? (
          <Field>
            <FieldLabel htmlFor="project-template-reference">GitHub template</FieldLabel>
            <Input
              id="project-template-reference"
              value={customTemplate}
              onChange={(event) => setCustomTemplate(event.target.value)}
              placeholder="github:owner/repo#path:template"
              required
            />
          </Field>
        ) : null}
        {orgs.length ? (
          <Field>
            <FieldLabel htmlFor="project-organization">Organization</FieldLabel>
            <NativeSelect
              id="project-organization"
              className="w-full"
              value={orgId}
              onChange={(event) => setPicked(event.target.value)}
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
        {canCreateOrg ? null : (
          <AllowOrganizations
            next={
              initialTemplate
                ? `/projects?new=1&template=${encodeURIComponent(initialTemplate)}`
                : "/projects?new=1"
            }
          />
        )}
        {error ? (
          <p role="alert" data-type="error" className="text-sm text-destructive">
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

/** `?template=` as the sheet's two template fields: a `github:` reference goes in the custom field;
 *  a name is the built-in whose path is `configs/<name>` — `default`, and a name that is none,
 *  is Minimal (the default files). */
function templateFields(
  template: string | undefined,
  options: { reference: string }[],
): { template: string; customTemplate: string } {
  if (template?.startsWith("github:")) return { template: "custom", customTemplate: template };
  const builtIn = options.find(
    (option) => parseConfigRepoTemplateReference(option.reference).path === `configs/${template}`,
  );
  return { template: builtIn?.reference || "", customTemplate: "" };
}
