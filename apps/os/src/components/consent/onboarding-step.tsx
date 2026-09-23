import { useId, type FormEvent, type Ref } from "react";
import { Button } from "@iterate-com/ui/components/button";
import { ConsentPanel, StepHeading, type ConsentFrame } from "./consent-step.tsx";
import { ProjectFields } from "./project-fields.tsx";

/** The first step for someone with no project yet: create one. Its button sits with Cancel in the
 *  panel's other column, joined to the form by `form`, so Enter in a field still submits. */
export function OnboardingStep({
  headingRef,
  frame,
  fields,
  onCreateProject,
}: {
  headingRef: Ref<HTMLHeadingElement>;
  frame: ConsentFrame;
  fields: Parameters<typeof ProjectFields>[0];
  onCreateProject: (event: FormEvent<HTMLFormElement>) => void;
}) {
  const formId = useId();
  return (
    <ConsentPanel
      {...frame}
      action={
        <Button type="submit" form={formId} size="lg" className="h-11" disabled={fields.disabled}>
          Review permissions
        </Button>
      }
    >
      <StepHeading ref={headingRef}>Create a project</StepHeading>
      <form id={formId} onSubmit={onCreateProject}>
        <ProjectFields {...fields} />
      </form>
    </ConsentPanel>
  );
}
