import type { FormEvent, Ref } from "react";
import { Button } from "@iterate-com/ui/components/button";
import { ConsentFooter, StepHeading } from "./consent-step.tsx";
import { ProjectChoices, type ProjectRow, type ProjectSelection } from "./project-choices.tsx";
import { ProjectFields } from "./project-fields.tsx";

/** The first step for someone with projects: which the client may reach, and a project made on the
 *  spot when none fits. */
export function ProjectsStep({
  headingRef,
  projects,
  projectBound,
  selection,
  fields,
  canReview,
  error,
  denyLocation,
  onSelectionChange,
  onCreateProject,
  onReview,
}: {
  headingRef: Ref<HTMLHeadingElement>;
  projects: ProjectRow[];
  projectBound: boolean;
  selection: ProjectSelection;
  fields: Parameters<typeof ProjectFields>[0];
  canReview: boolean;
  error: string | null;
  denyLocation: string;
  onSelectionChange: (selection: ProjectSelection) => void;
  onCreateProject: (event: FormEvent<HTMLFormElement>) => void;
  onReview: () => void;
}) {
  const { draft, disabled, onDraftChange } = fields;
  return (
    <section className="flex flex-col gap-4">
      <StepHeading ref={headingRef}>Select projects</StepHeading>
      <ProjectChoices
        projects={projects}
        projectBound={projectBound}
        selection={selection}
        creating={draft.open}
        disabled={disabled}
        onSelectionChange={onSelectionChange}
        onCreatingChange={(open) => onDraftChange({ ...draft, open })}
      />
      {draft.open ? (
        <form
          aria-label="New project"
          onSubmit={onCreateProject}
          className="flex flex-col gap-4 rounded-lg border p-4"
        >
          <h3 className="text-sm font-medium">New project</h3>
          <ProjectFields {...fields} focusSlug />
          <Button type="submit" variant="secondary" disabled={disabled}>
            Create project
          </Button>
        </form>
      ) : null}
      <ConsentFooter error={error} denyLocation={denyLocation}>
        <Button type="button" size="lg" disabled={disabled || !canReview} onClick={onReview}>
          Review permissions
        </Button>
      </ConsentFooter>
    </section>
  );
}
