// Shared pieces of the /projects organization-management pages. The `-`
// filename prefix keeps this out of the generated route tree (TanStack
// Router's convention for colocated non-route files).
import { useEffect, useState, type ReactNode } from "react";
import { z } from "zod/v4";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@iterate-com/ui/components/alert-dialog";
import { Badge } from "@iterate-com/ui/components/badge";
import { Button } from "@iterate-com/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@iterate-com/ui/components/dialog";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@iterate-com/ui/components/empty";
import { Field, FieldError, FieldGroup, FieldLabel } from "@iterate-com/ui/components/field";
import { Identifier } from "@iterate-com/ui/components/identifier";
import { Input } from "@iterate-com/ui/components/input";
import { NativeSelect, NativeSelectOption } from "@iterate-com/ui/components/native-select";
import { queryOptions } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { orpcClient } from "../../utils/query.tsx";

type Organization = Awaited<ReturnType<typeof orpcClient.user.myOrganizations>>[number];
export type Project = Awaited<ReturnType<typeof orpcClient.project.list>>[number];
export type InventoryOrganization = Organization & { projects: Project[] };

export function inventoryQueryOptions() {
  return queryOptions({
    queryKey: ["auth", "workspace-inventory"] as const,
    queryFn: loadInventory,
  });
}

async function loadInventory(): Promise<InventoryOrganization[]> {
  const organizations = await orpcClient.user.myOrganizations();
  return await Promise.all(
    organizations.map(async (organization) => ({
      ...organization,
      projects: await orpcClient.project.list({ organizationSlug: organization.slug }),
    })),
  );
}

export function OrganizationRail(props: {
  organizations: InventoryOrganization[];
  selectedOrganizationSlug: string;
}) {
  return (
    <aside className="overflow-hidden rounded-lg border bg-card">
      <div className="border-b px-4 py-3">
        <p className="text-sm font-medium">Organizations</p>
        <p className="text-xs text-muted-foreground">Choose one to manage.</p>
      </div>
      <div className="max-h-[620px] overflow-y-auto p-2">
        {props.organizations.map((organization) => {
          const selected = organization.slug === props.selectedOrganizationSlug;
          return (
            <Link
              key={organization.id}
              to="/projects/{-$organizationSlug}"
              params={{ organizationSlug: organization.slug }}
              className={[
                "flex w-full items-start gap-3 rounded-md px-3 py-3 text-left transition-colors",
                selected ? "bg-primary text-primary-foreground" : "hover:bg-muted",
              ].join(" ")}
            >
              <span
                className={[
                  "flex size-9 shrink-0 items-center justify-center rounded-md border text-xs font-semibold",
                  selected ? "border-primary-foreground/30" : "bg-background",
                ].join(" ")}
              >
                {organization.name.slice(0, 2).toUpperCase()}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">{organization.name}</span>
                <span
                  className={[
                    "block truncate text-xs",
                    selected ? "text-primary-foreground/75" : "text-muted-foreground",
                  ].join(" ")}
                >
                  {organization.projects.length} project
                  {organization.projects.length === 1 ? "" : "s"} · {organization.role}
                </span>
              </span>
            </Link>
          );
        })}
      </div>
    </aside>
  );
}

export function OrganizationDetail(props: {
  organization: InventoryOrganization;
  canManage: boolean;
  onCreateProject: () => void;
  onDeleteOrganization: () => void;
  onDeleteProject: (project: Project) => void;
}) {
  return (
    <section className="min-w-0 overflow-hidden rounded-lg border bg-card">
      <div className="flex flex-col gap-4 border-b px-5 py-4 md:flex-row md:items-start md:justify-between">
        <div className="min-w-0 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="truncate text-lg font-semibold">{props.organization.name}</h2>
            <Badge variant={props.organization.role === "owner" ? "default" : "outline"}>
              {props.organization.role}
            </Badge>
          </div>
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
            <span>{props.organization.slug}</span>
            <span>{props.organization.projects.length} projects</span>
            <Identifier value={props.organization.id} textClassName="text-xs" />
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" disabled={!props.canManage} onClick={props.onCreateProject}>
            New project
          </Button>
          <Button
            size="sm"
            variant="destructive"
            disabled={props.organization.role !== "owner"}
            onClick={props.onDeleteOrganization}
          >
            Delete
          </Button>
        </div>
      </div>

      {props.organization.projects.length === 0 ? (
        <Empty className="min-h-[360px] border-0">
          <EmptyHeader>
            <EmptyTitle>No projects in this organization</EmptyTitle>
            <EmptyDescription>Create one when this organization is ready.</EmptyDescription>
          </EmptyHeader>
          <Button disabled={!props.canManage} onClick={props.onCreateProject}>
            Create project
          </Button>
        </Empty>
      ) : (
        <div className="divide-y">
          {props.organization.projects.map((project) => (
            <ProjectRow
              key={project.id}
              project={project}
              canManage={props.canManage}
              onDelete={() => props.onDeleteProject(project)}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function ProjectRow(props: { project: Project; canManage: boolean; onDelete: () => void }) {
  const metadataKeys = Object.keys(props.project.metadata);
  return (
    <article className="grid gap-3 px-5 py-4 md:grid-cols-[minmax(0,1fr)_auto] md:items-center">
      <div className="min-w-0 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="truncate text-sm font-medium">{props.project.name}</h3>
          {props.project.archivedAt ? <Badge variant="secondary">Archived</Badge> : null}
        </div>
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
          <span>{props.project.slug}</span>
          <Identifier value={props.project.id} textClassName="text-xs" />
          <span>
            {metadataKeys.length === 0
              ? "No metadata"
              : `${metadataKeys.length} metadata ${metadataKeys.length === 1 ? "key" : "keys"}`}
          </span>
        </div>
      </div>
      <div className="flex gap-2">
        <Button
          size="sm"
          variant="destructive"
          disabled={!props.canManage}
          onClick={props.onDelete}
        >
          Delete
        </Button>
      </div>
    </article>
  );
}

// The selected organization is the parent's `state`, not local state — the
// select writes straight back through onStateChange, so there's nothing to
// sync.
export function ProjectDialog(props: {
  state: { organizationSlug: string } | null;
  organizations: InventoryOrganization[];
  isPending: boolean;
  onOpenChange: (open: boolean) => void;
  onStateChange: (state: { organizationSlug: string }) => void;
  onSubmit: (input: { name: string; organizationSlug: string }) => void;
}) {
  return (
    <NameDialog
      open={Boolean(props.state)}
      title="Create project"
      description="Name the project users should recognize."
      label="Project name"
      submitLabel="Create project"
      isPending={props.isPending}
      onOpenChange={props.onOpenChange}
      extraFields={
        props.state ? (
          <Field>
            <FieldLabel htmlFor="project-organization">Organization</FieldLabel>
            <NativeSelect
              id="project-organization"
              className="w-full"
              value={props.state.organizationSlug}
              onChange={(event) => props.onStateChange({ organizationSlug: event.target.value })}
              disabled={props.isPending}
            >
              {props.organizations.map((organization) => (
                <NativeSelectOption key={organization.id} value={organization.slug}>
                  {organization.name}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </Field>
        ) : null
      }
      onSubmit={(input) =>
        props.state && props.onSubmit({ ...input, organizationSlug: props.state.organizationSlug })
      }
    />
  );
}

const NameInput = z.object({
  name: z.string().trim().min(1, "Name is required").max(100, "Keep it under 100 characters"),
});

export function NameDialog(props: {
  open: boolean;
  title: string;
  description: string;
  label: string;
  submitLabel: string;
  isPending: boolean;
  extraFields?: ReactNode;
  onOpenChange: (open: boolean) => void;
  onSubmit: (input: z.infer<typeof NameInput>) => void;
}) {
  const [name, setName] = useState("");
  const parsed = NameInput.safeParse({ name });

  useEffect(() => {
    if (props.open) setName("");
  }, [props.open]);

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{props.title}</DialogTitle>
          <DialogDescription>{props.description}</DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (!parsed.success) return;
            props.onSubmit(parsed.data);
          }}
        >
          <FieldGroup>
            {props.extraFields}
            <Field data-invalid={!parsed.success && name.length > 0}>
              <FieldLabel htmlFor="name">{props.label}</FieldLabel>
              <Input
                id="name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                disabled={props.isPending}
                aria-invalid={!parsed.success && name.length > 0}
              />
              {!parsed.success && name.length > 0 ? (
                <FieldError errors={parsed.error.issues} />
              ) : null}
            </Field>
          </FieldGroup>
          <DialogFooter showCloseButton>
            <Button type="submit" disabled={!parsed.success || props.isPending}>
              {props.isPending ? "Saving..." : props.submitLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function DeleteOrganizationDialog(props: {
  organization: InventoryOrganization | null;
  isPending: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}) {
  return (
    <AlertDialog open={Boolean(props.organization)} onOpenChange={props.onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete organization?</AlertDialogTitle>
          <AlertDialogDescription>
            {props.organization
              ? `${props.organization.name} and its ${props.organization.projects.length} projects will be removed.`
              : "This organization will be removed."}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={props.isPending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={props.isPending}
            onClick={props.onConfirm}
          >
            {props.isPending ? "Deleting..." : "Delete"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export function DeleteProjectDialog(props: {
  project: Project | null;
  isPending: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}) {
  return (
    <AlertDialog open={Boolean(props.project)} onOpenChange={props.onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete project?</AlertDialogTitle>
          <AlertDialogDescription>
            {props.project
              ? `${props.project.name} will stop appearing in project access grants.`
              : "This project will be removed."}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={props.isPending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={props.isPending}
            onClick={props.onConfirm}
          >
            {props.isPending ? "Deleting..." : "Delete"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
