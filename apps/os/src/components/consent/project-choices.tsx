import { useId } from "react";
import { Button } from "@iterate-com/ui/components/button";
import { Checkbox } from "@iterate-com/ui/components/checkbox";
import { Label } from "@iterate-com/ui/components/label";

/** A project the person reaches, with its organization's name for the list. */
export interface ProjectRow {
  id: string;
  slug: string;
  orgName: string;
}

/** Which projects the client may reach: every one now and later, or the ones ticked. Choosing all
 *  parks the individual ticks, so narrowing access again restores them. */
export interface ProjectSelection {
  all: boolean;
  /** the projects unticked; a project created on the page starts ticked */
  excluded: ReadonlySet<string>;
}

/** The project list with its either/or — all projects, or those ticked — and the New project
 *  toggle. A client bound to one project has neither choice. */
export function ProjectChoices({
  projects,
  projectBound,
  selection,
  creating,
  disabled,
  onSelectionChange,
  onCreatingChange,
}: {
  projects: ProjectRow[];
  projectBound: boolean;
  selection: ProjectSelection;
  creating: boolean;
  disabled: boolean;
  onSelectionChange: (selection: ProjectSelection) => void;
  onCreatingChange: (creating: boolean) => void;
}) {
  // The label around a checkbox names it too (Base UI); these name each project "<slug> in <org>".
  const id = useId();
  function tick(projectId: string, checked: boolean) {
    const excluded = new Set(selection.excluded);
    if (checked) excluded.delete(projectId);
    else excluded.add(projectId);
    onSelectionChange({ ...selection, excluded });
  }
  return (
    <fieldset aria-label="Projects it may reach" className="-mx-2 flex flex-col gap-1">
      {projectBound ? null : (
        <Label className="gap-3 rounded-lg px-2 py-2 leading-normal hover:bg-muted">
          <Checkbox
            className="border-foreground/30 data-disabled:opacity-50"
            checked={selection.all}
            disabled={disabled}
            onCheckedChange={(all) => onSelectionChange({ ...selection, all })}
          />
          All my projects, now and future
        </Label>
      )}
      {projects.map((project) => (
        <Label
          key={project.id}
          className="gap-3 rounded-lg px-2 py-2 leading-normal font-normal hover:bg-muted"
        >
          <Checkbox
            className="border-foreground/30 data-disabled:opacity-50"
            aria-labelledby={`${id}-${project.id}-slug ${id}-${project.id}-in ${id}-${project.id}-org`}
            checked={selection.all || !selection.excluded.has(project.id)}
            disabled={disabled || selection.all}
            onCheckedChange={(checked) => tick(project.id, checked)}
          />
          <span className="flex min-w-0 flex-col">
            <span id={`${id}-${project.id}-slug`} className="truncate font-mono">
              {project.slug}
            </span>
            <span id={`${id}-${project.id}-in`} className="sr-only">
              in
            </span>
            <span id={`${id}-${project.id}-org`} className="truncate text-xs text-muted-foreground">
              {project.orgName}
            </span>
          </span>
        </Label>
      ))}
      {projectBound && !projects.length ? (
        <p className="px-2 text-sm text-muted-foreground">
          You do not have access to this app’s project.
        </p>
      ) : null}
      {projectBound ? null : (
        <Button
          type="button"
          variant="ghost"
          className="justify-start"
          aria-expanded={creating}
          disabled={disabled}
          onClick={() => onCreatingChange(!creating)}
        >
          <span aria-hidden="true">+</span>
          New project
        </Button>
      )}
    </fieldset>
  );
}
