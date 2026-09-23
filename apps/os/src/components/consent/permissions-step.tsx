import { useState, type Ref } from "react";
import { Button } from "@iterate-com/ui/components/button";
import type { ConsentScope } from "iterate/next/oauth-scopes";
import { ConsentFooter, StepHeading } from "./consent-step.tsx";
import type { ProjectRow } from "./project-choices.tsx";
import { PermissionChoices, SelectedProjects } from "./review-summary.tsx";

/** The last step: the projects chosen, the permissions to grant, and Authorize — a plain POST to
 *  this very authorization URL carrying the choices as `project` and `scope` fields. */
export function PermissionsStep({
  headingRef,
  all,
  selected,
  scopes,
  declined,
  error,
  denyLocation,
  disabled,
  onDeclinedChange,
  onEditProjects,
}: {
  headingRef: Ref<HTMLHeadingElement>;
  all: boolean;
  selected: ProjectRow[];
  scopes: ConsentScope[];
  declined: ReadonlySet<string>;
  error: string | null;
  denyLocation: string;
  disabled: boolean;
  onDeclinedChange: (declined: ReadonlySet<string>) => void;
  onEditProjects: () => void;
}) {
  const [authorizing, setAuthorizing] = useState(false);
  const projectFields = all ? ["*"] : selected.map((project) => project.id);
  const granted = scopes.filter((scope) => scope.required || !declined.has(scope.name));
  return (
    <form method="post" onSubmit={() => setAuthorizing(true)} className="flex flex-col gap-4">
      <StepHeading ref={headingRef}>Review permissions</StepHeading>
      <SelectedProjects all={all} projects={selected} disabled={disabled} onEdit={onEditProjects} />
      <PermissionChoices
        scopes={scopes}
        declined={declined}
        disabled={disabled}
        onDeclinedChange={onDeclinedChange}
      />
      {projectFields.map((project) => (
        <input key={project} type="hidden" name="project" value={project} />
      ))}
      {granted.map((scope) => (
        <input key={scope.name} type="hidden" name="scope" value={scope.name} />
      ))}
      <ConsentFooter error={error} denyLocation={denyLocation}>
        <Button type="submit" size="lg" disabled={disabled || authorizing}>
          Authorize
        </Button>
      </ConsentFooter>
    </form>
  );
}
