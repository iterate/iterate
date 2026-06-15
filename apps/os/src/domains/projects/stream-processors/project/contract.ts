// Contract for the "project" processor: the event-sourced record of a
// Project's life. Deliberately import-light (no cloudflare:workers) so the
// docs catalog (src/lib/event-docs.ts) and other Node-side consumers can read
// it; the side effects live in ./implementation.ts.
//
// Creation is a request followed by observable steps, not a method body:
//
//   project/create-requested   { projectId, slug }            — the form values
//   project/created            { projectId, slug, hosts, … }  — registered, hosts assigned
//   project/create-completed   { projectId }                  — registration done
//
// The project's worker leaves no events here: it is a repo-sourced
// capability built through the generic per-commit memo (itx/source-build.ts);
// worker lifecycle events belong to the REPO's stream (future manifest work).

import { z } from "zod";
import { defineProcessorContract } from "@iterate-com/shared/streams/stream-processors";
import { StreamPath } from "@iterate-com/shared/streams/types";
import { CoreProcessorContract } from "~/domains/streams/engine/processors/core/contract.ts";
import { normalizeIngressHost } from "~/ingress/host-headers.ts";
import type { AppConfig } from "~/config.ts";

export const PROJECT_STREAM_PATH = StreamPath.parse("/");

/** What the created event records; also the project's summary shape. */
const ProjectFacts = z.object({
  defaultHost: z.string().trim().min(1),
  hosts: z.array(z.string().trim().min(1)),
  projectId: z.string().trim().min(1),
  slug: z.string().trim().min(1),
});

export type ProjectFacts = z.infer<typeof ProjectFacts>;

/** Pure: a project's hosts derive entirely from (projectId, slug, config). */
export function projectFacts(input: {
  config: AppConfig;
  projectId: string;
  slug: string;
}): ProjectFacts {
  const bases = input.config.projectHostnameBases;
  return {
    defaultHost: normalizeIngressHost(`${input.slug}.${bases[0] ?? "iterate.localhost"}`),
    hosts: bases.flatMap((base) => [
      normalizeIngressHost(`${input.slug}.${base}`),
      normalizeIngressHost(`${input.projectId}.${base}`),
    ]),
    projectId: input.projectId,
    slug: input.slug,
  };
}

export const ProjectProcessorContract = defineProcessorContract({
  slug: "project",
  version: "0.4.0",
  description:
    "Projects the Project's lifecycle events, drives creation side effects, and forwards project-root facts to the Project worker.",
  stateSchema: z.object({
    onboarding: z.enum(["in-progress", "completed"]).default("in-progress"),
    phase: z.enum(["none", "creating", "ready"]).default("none"),
    project: ProjectFacts.nullable().default(null),
  }),
  initialState: {
    onboarding: "in-progress",
    phase: "none",
    project: null,
  },
  processorDeps: [CoreProcessorContract],
  events: {
    "events.iterate.com/project/create-requested": {
      description: "Project creation was requested with these form values.",
      payloadSchema: z.object({
        projectId: z.string().trim().min(1),
        slug: z.string().trim().min(1),
      }),
    },
    "events.iterate.com/project/created": {
      description: "The Project was registered and its platform hosts were assigned.",
      payloadSchema: ProjectFacts,
    },
    "events.iterate.com/project/repo-initialized": {
      description: "The Project's repo exists and is cloneable.",
      payloadSchema: z.object({
        defaultBranch: z.string().trim().min(1),
        projectId: z.string().trim().min(1),
        repoSlug: z.string().trim().min(1),
      }),
    },
    "events.iterate.com/project/create-completed": {
      description: "All Project creation steps completed.",
      payloadSchema: z.object({
        projectId: z.string().trim().min(1),
      }),
    },
    "events.iterate.com/project/onboarding-completed": {
      description: "The Project's initial onboarding memory was committed to the project repo.",
      payloadSchema: z.object({
        agentPath: z.literal("/agents/onboarding"),
        commitOid: z.string().trim().min(1),
        projectId: z.string().trim().min(1),
      }),
    },
  },
  consumes: [
    "*",
    "events.iterate.com/project/create-requested",
    "events.iterate.com/project/created",
    "events.iterate.com/project/create-completed",
    "events.iterate.com/project/onboarding-completed",
    "events.iterate.com/stream/child-stream-created",
  ],
  emits: [
    "events.iterate.com/project/created",
    "events.iterate.com/project/repo-initialized",
    "events.iterate.com/project/create-completed",
  ],
});

export type ProjectProcessorContract = typeof ProjectProcessorContract;

export type ProjectProcessorState = z.infer<typeof ProjectProcessorContract.stateSchema>;
