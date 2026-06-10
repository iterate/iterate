// Contract for the "project" processor: the event-sourced record of a
// Project's life. Deliberately import-light (no cloudflare:workers) so the
// docs catalog (src/lib/event-docs.ts) and other Node-side consumers can read
// it; the side effects live in ./implementation.ts.
//
// Creation is a request followed by observable steps, not a method body:
//
//   project/create-requested   { projectId, slug }            — the form values
//   project/created            { projectId, slug, hosts, … }  — registered, hosts assigned
//   project/config-worker-built{ commitOid, … }               — worker built (also re-fires
//                                                               on later rebuilds)
//   project/create-completed   { projectId }                  — registration done

import { z } from "zod";
import { defineProcessorContract } from "@iterate-com/streams/shared/stream-processors";
import { StreamPath } from "@iterate-com/shared/streams/types";
import { normalizeIngressHost } from "~/ingress/host-routing.ts";
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
  version: "0.2.0",
  description: "Projects the Project's lifecycle events and drives creation side effects.",
  stateSchema: z.object({
    phase: z.enum(["none", "creating", "ready"]).default("none"),
    project: ProjectFacts.nullable().default(null),
    worker: z
      .object({
        commitOid: z.string().trim().min(1),
        mainModule: z.string().trim().min(1),
        repoSlug: z.string().trim().min(1),
      })
      .nullable()
      .default(null),
  }),
  initialState: {
    phase: "none",
    project: null,
    worker: null,
  },
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
      description: "The Project's iterate-config repo exists and is cloneable.",
      payloadSchema: z.object({
        defaultBranch: z.string().trim().min(1),
        projectId: z.string().trim().min(1),
        repoSlug: z.string().trim().min(1),
      }),
    },
    // Historical type string ("config worker" is now just "the worker").
    "events.iterate.com/project/config-worker-built": {
      description: "The Project's worker was built and cached for dispatch.",
      payloadSchema: z.object({
        commitOid: z.string().trim().min(1),
        mainModule: z.string().trim().min(1),
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
  },
  // "*" makes the stream deliver every event (the worker forwarding in
  // processEventBatch needs unfiltered batches); the named types are what
  // reduce projects into state.
  consumes: [
    "*",
    "events.iterate.com/project/create-requested",
    "events.iterate.com/project/created",
    "events.iterate.com/project/config-worker-built",
    "events.iterate.com/project/create-completed",
  ],
  emits: [
    "events.iterate.com/project/created",
    "events.iterate.com/project/repo-initialized",
    "events.iterate.com/project/config-worker-built",
    "events.iterate.com/project/create-completed",
  ],
});

export type ProjectProcessorContract = typeof ProjectProcessorContract;

export type ProjectProcessorState = z.infer<typeof ProjectProcessorContract.stateSchema>;
