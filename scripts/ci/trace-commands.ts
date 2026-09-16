import { parse } from "yaml";
import { z } from "zod";

/** Use source YAML, never expanded runner commands that could contain credentials. */
export function stepCommands(source: string) {
  const workflow = SourceWorkflow.parse(parse(source));
  const commands = new Map<string, string>();
  for (const [job, definition] of Object.entries(workflow.jobs)) {
    function visit(value: unknown) {
      const step = Step.parse(value);
      if (step.id && step.run) {
        commands.set(
          `${job}/${step.id}`,
          step.run
            .replace(/\\\r?\n\s*/g, " ")
            .replace(/(^|\n)[ \t]*doppler run\b[^\n]*? --[ \t]+/g, "$1")
            .trim(),
        );
      }
      for (const child of [...(step.parallel || []), ...(step.sequential || [])]) visit(child);
    }
    for (const step of definition.steps) visit(step);
  }
  return commands;
}

const SourceWorkflow = z.object({
  jobs: z.record(z.string(), z.object({ steps: z.array(z.unknown()) })),
});
const Step = z.object({
  id: z.string().optional(),
  run: z.string().optional(),
  parallel: z.array(z.unknown()).optional(),
  sequential: z.array(z.unknown()).optional(),
});
