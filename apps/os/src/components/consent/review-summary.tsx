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
    <section aria-label="Selected projects" className="flex flex-col gap-3 rounded-xl border p-4">
      <div className="flex items-center justify-between gap-4">
        <h3 className="text-sm font-medium">Project access</h3>
        <Button
          type="button"
          variant="outline"
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
            <li key={project.id} className="flex min-w-0 items-baseline gap-2">
              <strong className="truncate font-mono font-medium">{project.slug}</strong>
              <span className="truncate text-xs text-muted-foreground">{project.orgName}</span>
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
    <section aria-label="Permissions" className="flex flex-col divide-y">
      {scopes.map((scope) => (
        <Label
          key={scope.name}
          className="items-start gap-3 py-4 leading-normal font-normal first:pt-0 last:pb-0"
        >
          <Checkbox
            className="mt-0.5 border-foreground/30 data-disabled:opacity-50"
            aria-label={scope.title}
            checked={scope.required || !declined.has(scope.name)}
            disabled={disabled || scope.required}
            onCheckedChange={(checked) => tick(scope.name, checked)}
          />
          <span className="flex flex-col gap-0.5">
            <strong className="font-medium">{scope.title}</strong>
            <span className="text-xs text-muted-foreground">{scope.note}</span>
          </span>
        </Label>
      ))}
    </section>
  );
}
