// ai-linter/contract.ts — THE AI LINTER: a processor on a GitHub connection's log
// (/integrations/github/<connection>). Each pull request of the installed repository that is opened,
// reopened, readied or pushed to is linted once per head against the rules folder of that repository
// AT THE PULL REQUEST'S BASE, and the verdict lands on GitHub as the connection's App: a COMMENT
// review with inline comments (when there are findings), then the "Iterate GitHub AI linter" Check
// Run, success or neutral. Never blocking. processor.ts queues the heads, run.ts is one lint (and
// publishes what it has when a part of it fails), install.ts mounts it.
//
// `ai-linter/installed` holds the install's choices, the latest marker's: the repository, its rules
// folder and the LLM's model; the log's history before the first marker is never linted.
// `ai-linter/linted` is the outcome of each delivery that queued a head.
import { z } from "zod";
import { defineProcessorContract } from "iterate/stream/processor";

/** A head to lint, and the offset of the delivery that queued it. */
export const AiLinterJob = z.object({
  key: z.string(),
  offset: z.number(),
  connection: z.string(),
  repository: z.string(),
  number: z.number(),
  headSha: z.string(),
  baseSha: z.string(),
});

export const AiLinterContract = defineProcessorContract({
  slug: "ai-linter",
  version: "1",
  description: "Lints each pull request head of the installed repository against its rules folder.",
  stateSchema: z.object({
    repository: z.string().nullable().default(null),
    /** The install's rules folder in the repository, or none for `rules`. */
    rules: z.string().optional(),
    /** The install's model for the LLM, or none for run.ts's default. */
    model: z.string().optional(),
    queue: z.array(AiLinterJob).default([]),
  }),
  consumes: [
    "events.iterate.com/github/webhook-received",
    "ai-linter/installed",
    "ai-linter/linted",
  ],
  emits: ["ai-linter/linted"],
});
