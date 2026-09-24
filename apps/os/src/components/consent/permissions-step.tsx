import { useId, useState, type Ref } from "react";
import { Button } from "@iterate-com/ui/components/button";
import type { ConsentScope } from "iterate/oauth-scopes";
import { ConsentPanel, StepHeading, type ConsentFrame } from "./consent-step.tsx";
import type { ProjectRow } from "./project-choices.tsx";
import { PermissionChoices, SelectedProjects } from "./review-summary.tsx";

/** The last step: the permissions to grant beside the projects chosen, and Authorize — a plain POST
 *  to this very authorization URL carrying the choices as `project` and `scope` fields. Authorize
 *  sits in the panel's other column, joined to the form by `form`. */
export function PermissionsStep({
  headingRef,
  frame,
  all,
  selected,
  scopes,
  declined,
  disabled,
  onDeclinedChange,
  onEditProjects,
}: {
  headingRef: Ref<HTMLHeadingElement>;
  frame: ConsentFrame;
  all: boolean;
  selected: ProjectRow[];
  scopes: ConsentScope[];
  declined: ReadonlySet<string>;
  disabled: boolean;
  onDeclinedChange: (declined: ReadonlySet<string>) => void;
  onEditProjects: () => void;
}) {
  const formId = useId();
  const [authorizing, setAuthorizing] = useState(false);
  const projectFields = all ? ["*"] : selected.map((project) => project.id);
  const granted = scopes.filter((scope) => scope.required || !declined.has(scope.name));
  return (
    <ConsentPanel
      {...frame}
      summary={
        <SelectedProjects
          all={all}
          projects={selected}
          disabled={disabled}
          onEdit={onEditProjects}
        />
      }
      action={
        <Button
          type="submit"
          form={formId}
          size="lg"
          className="h-11"
          disabled={disabled || authorizing}
        >
          Authorize
        </Button>
      }
    >
      <StepHeading ref={headingRef}>Review permissions</StepHeading>
      <form id={formId} method="post" onSubmit={() => setAuthorizing(true)}>
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
      </form>
    </ConsentPanel>
  );
}
