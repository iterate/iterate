import { Button } from "@iterate-com/ui/components/button";
import { Checkbox } from "@iterate-com/ui/components/checkbox";
import { Label } from "@iterate-com/ui/components/label";
import type { ConsentScope } from "iterate/next/oauth-scopes";
import type { ProjectRow } from "./project-choices.tsx";

/** The projects chosen on the first step, with the way back to change them. */
export function SelectedProjects({
  all,
  projects,
  disabled,
  onEdit,
}: {
  all: boolean;
  projects: ProjectRow[];
  disabled: boolean;
  onEdit: () => void;
}) {
  return (
    <section aria-label="Selected projects" className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium">Project access</h3>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-label="Edit selected projects"
          disabled={disabled}
          onClick={onEdit}
        >
          Edit
        </Button>
      </div>
      {all ? (
        <p className="text-sm font-medium">All my projects, now and future</p>
      ) : (
        <ul className="flex flex-col gap-1 text-sm">
          {projects.map((project) => (
            <li key={project.id} className="flex items-baseline gap-2">
              <strong className="font-mono font-medium">{project.slug}</strong>
              <span className="text-xs text-muted-foreground">{project.orgName}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** The permissions the request asked for; a required one stays ticked. */
export function PermissionChoices({
  scopes,
  declined,
  disabled,
  onDeclinedChange,
}: {
  scopes: ConsentScope[];
  declined: ReadonlySet<string>;
  disabled: boolean;
  onDeclinedChange: (declined: ReadonlySet<string>) => void;
}) {
  function tick(name: string, checked: boolean) {
    const next = new Set(declined);
    if (checked) next.delete(name);
    else next.add(name);
    onDeclinedChange(next);
  }
  return (
    <section aria-label="Permissions" className="flex flex-col gap-1">
      {scopes.map((scope) => (
        <Label
          key={scope.name}
          className="items-start gap-3 rounded-lg px-2 py-2 leading-normal font-normal"
        >
          <Checkbox
            className="mt-0.5"
            aria-label={scope.title}
            checked={scope.required || !declined.has(scope.name)}
            disabled={disabled || scope.required}
            onCheckedChange={(checked) => tick(scope.name, checked)}
          />
          <span className="flex flex-col gap-0.5">
            <strong className="font-medium">{scope.title}</strong>
            <span className="text-muted-foreground">{scope.note}</span>
          </span>
        </Label>
      ))}
    </section>
  );
}
