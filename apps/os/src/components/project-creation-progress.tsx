import { useEffect, useState } from "react";
import { CheckIcon, LoaderCircleIcon } from "lucide-react";
import { Button } from "@iterate-com/ui/components/button";
import { cn } from "@iterate-com/ui/lib/utils";
import type { ProjectProcessorState } from "../domains/projects/project-processor-contract.ts";

// Bootstrap commits every step within seconds, so a long quiet gap means the
// saga needs a kick, not more patience. Comfortably past the e2e green-path
// budget (60s covers birth + saga + handoff) so healthy creates never see it.
const STALL_AFTER_MS = 90_000;

/**
 * One bootstrap milestone, derived purely from the project processor's reduced
 * state — no step machine, no extra events: each tick is a fact the fold
 * already records, so the checklist is exactly as live as the pushes feeding
 * `useProjectProcessorState`.
 */
type CreationStep = {
  key: string;
  label: string;
  done: boolean;
};

function creationSteps(state: ProjectProcessorState | undefined): CreationStep[] {
  // `undefined` = the first push has not arrived yet: nothing is ticked.
  // Row order mirrors the saga's actual commit order (see the create-timing
  // steps in projects.create): slack routing is appended right after the root
  // saga, then the repo seeds (the slow artifact step) — so ticks appear top
  // to bottom instead of a later row completing while an earlier one spins.
  // The onboarding agent is not a saga step: its chat page explicitly creates
  // it before sending the first message.
  return [
    { key: "registered", label: "Registering project", done: state?.birthCertificate != null },
    {
      key: "integrations",
      label: "Wiring integrations",
      done:
        state !== undefined &&
        (state.streams.some((stream) => stream.path === "/integrations/email") || state.ready),
    },
    { key: "repo", label: "Seeding repository", done: (state?.repos.length ?? 0) > 0 },
    { key: "ready", label: "Finalizing project", done: state?.ready ?? false },
  ];
}

/**
 * The "Creating project" checklist the home page shows until the bootstrap
 * saga commits `project/ready`. Every tick appears the moment the processor
 * pushes the state change that records it; the first not-yet-done step wears
 * the spinner.
 */
export function ProjectCreationProgress({ state }: { state: ProjectProcessorState | undefined }) {
  const steps = creationSteps(state);
  const activeIndex = steps.findIndex((step) => !step.done);
  // Deadline restarts on every tick: a stalled saga must surface as a
  // recoverable state, not an eternal spinner. Reload re-dials live state,
  // and that dial snapshots the processor — which folds any stuck events, so
  // the button is a real kick, not just hope.
  const doneCount = steps.filter((step) => step.done).length;
  const [stalled, setStalled] = useState(false);
  useEffect(() => {
    setStalled(false);
    const timer = setTimeout(() => setStalled(true), STALL_AFTER_MS);
    return () => clearTimeout(timer);
  }, [doneCount]);

  return (
    <section
      className="mx-auto w-full max-w-md rounded-lg border bg-card p-6"
      data-testid="project-creation-progress"
    >
      <h1 className="text-lg font-semibold">Creating project</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Setting everything up — this page updates live as each step lands.
      </p>
      <ol className="mt-5 space-y-3">
        {steps.map((step, index) => {
          const active = index === activeIndex;
          return (
            <li
              key={step.key}
              className="flex items-center gap-3 text-sm"
              data-testid={`creation-step-${step.key}`}
              data-done={step.done ? "true" : undefined}
            >
              <span
                className={cn(
                  "flex size-6 shrink-0 items-center justify-center rounded-full border",
                  step.done
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-muted-foreground/30 text-muted-foreground",
                )}
              >
                {step.done ? (
                  <CheckIcon aria-hidden="true" className="size-4" />
                ) : active ? (
                  <LoaderCircleIcon
                    aria-hidden="true"
                    className="size-4 animate-spin"
                    data-spinner="true"
                  />
                ) : (
                  <span className="size-1.5 rounded-full bg-current opacity-40" />
                )}
              </span>
              <span className={cn(step.done ? "text-foreground" : "text-muted-foreground")}>
                {step.label}
              </span>
            </li>
          );
        })}
      </ol>
      {stalled ? (
        <div
          className="mt-5 rounded-md border border-dashed p-3 text-sm text-muted-foreground"
          data-testid="creation-stalled"
        >
          <p>
            This is taking longer than expected. Setup keeps running in the background — reloading
            usually gets it moving again.
          </p>
          <Button
            variant="outline"
            size="sm"
            className="mt-3 w-full"
            onClick={() => window.location.reload()}
          >
            Reload page
          </Button>
        </div>
      ) : null}
    </section>
  );
}
