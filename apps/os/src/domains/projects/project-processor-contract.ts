import { z } from "zod";
import { defineProcessorContract } from "../streams/processor-contracts.ts";
import { CoreProcessorContract } from "../streams/core-processor-contract.ts";
import { RepoProcessorContract } from "../repos/repo-processor-contract.ts";
import { AgentProcessorContract } from "../agents/agent-processor-contract.ts";

const StreamListItem = z.object({
  createdAt: z.string(),
  path: z.string(),
});

export const ProjectCustomDomainStatus = z.enum([
  "requested",
  "provisioning",
  "pending_validation",
  "active",
  "failed",
  "removing",
]);

export const ProjectCustomDomainValidationRecord = z.object({
  name: z.string(),
  status: z.string().nullable().default(null),
  value: z.string(),
});

export const ProjectCustomDomainCloudflareSnapshot = z.object({
  cloudflareHostnameId: z.string().nullable().default(null),
  error: z.string().nullable().default(null),
  hostname: z.string(),
  hostnameStatus: z.string().nullable().default(null),
  ownershipVerification: z
    .object({
      name: z.string(),
      value: z.string(),
    })
    .nullable()
    .default(null),
  sslStatus: z.string().nullable().default(null),
  status: ProjectCustomDomainStatus,
  validationRecords: z.array(ProjectCustomDomainValidationRecord).default([]),
  wildcard: z.boolean().default(true),
});

export const ProjectCustomDomain = ProjectCustomDomainCloudflareSnapshot.extend({
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type ProjectCustomDomain = z.output<typeof ProjectCustomDomain>;
export type ProjectCustomDomainCloudflareSnapshot = z.output<
  typeof ProjectCustomDomainCloudflareSnapshot
>;

export const ProjectProcessorContract = defineProcessorContract({
  slug: "project",
  version: "0.1.0",
  description:
    "Project projection: bootstrap the default repo/project worker and manage custom-domain routing.",
  stateSchema: z.object({
    createRequest: z
      .object({
        projectId: z.string(),
        slug: z.string(),
      })
      .nullable()
      .default(null),
    created: z.boolean().default(false),
    onboardingActive: z.boolean().default(false),
    onboardingCompletedAt: z.string().nullable().default(null),
    agents: z.array(StreamListItem).default([]),
    repos: z.array(StreamListItem).default([]),
    secrets: z.array(StreamListItem).default([]),
    streams: z.array(StreamListItem).default([]),
    customDomains: z.array(ProjectCustomDomain).default([]),
  }),
  events: {
    "events.iterate.com/project/create-requested": {
      description: "A project creation was requested.",
      payloadSchema: z.object({
        onboardingActive: z.boolean().optional(),
        projectId: z.string(),
        slug: z.string(),
      }),
    },
    "events.iterate.com/project/created": {
      description: "The project root was created.",
      payloadSchema: z.object({
        projectId: z.string(),
        slug: z.string(),
      }),
    },
    "events.iterate.com/project/onboarding-completed": {
      description: "The project owner completed the onboarding agent flow.",
      payloadSchema: z.object({
        agentPath: z.string(),
      }),
    },
    "events.iterate.com/project/custom-domain-add-requested": {
      description: "A custom domain should be provisioned and routed to this project.",
      payloadSchema: z.object({
        hostname: z.string(),
      }),
    },
    "events.iterate.com/project/custom-domain-refresh-requested": {
      description: "Refresh Cloudflare status for a custom domain.",
      payloadSchema: z.object({
        hostname: z.string(),
      }),
    },
    "events.iterate.com/project/custom-domain-remove-requested": {
      description: "A custom domain should be removed from this project.",
      payloadSchema: z.object({
        hostname: z.string(),
      }),
    },
    "events.iterate.com/project/custom-domain-cloudflare-observed": {
      description: "Cloudflare custom-hostname status observed for a project custom domain.",
      payloadSchema: ProjectCustomDomainCloudflareSnapshot,
    },
    "events.iterate.com/project/custom-domain-provision-failed": {
      description: "Custom-domain provisioning failed before an observed Cloudflare status.",
      payloadSchema: z.object({
        error: z.string(),
        hostname: z.string(),
      }),
    },
    "events.iterate.com/project/custom-domain-removed": {
      description: "A custom domain was removed from Cloudflare and routing KV.",
      payloadSchema: z.object({
        hostname: z.string(),
      }),
    },
  },
  consumes: [
    "*",
    "events.iterate.com/project/custom-domain-add-requested",
    "events.iterate.com/project/custom-domain-cloudflare-observed",
    "events.iterate.com/project/custom-domain-provision-failed",
    "events.iterate.com/project/custom-domain-refresh-requested",
    "events.iterate.com/project/custom-domain-remove-requested",
    "events.iterate.com/project/custom-domain-removed",
    "events.iterate.com/project/onboarding-completed",
    "events.iterate.com/project/created",
    "events.iterate.com/project/create-requested",
    "events.iterate.com/repo/created",
    "events.iterate.com/stream/created",
    "events.iterate.com/stream/child-stream-created",
  ],
  processorDeps: [CoreProcessorContract, RepoProcessorContract, AgentProcessorContract],
  emits: [
    "events.iterate.com/agent/config-updated",
    "events.iterate.com/agent/input-added",
    "events.iterate.com/agent/llm-provider-selected",
    "events.iterate.com/project/custom-domain-cloudflare-observed",
    "events.iterate.com/project/custom-domain-provision-failed",
    "events.iterate.com/project/custom-domain-removed",
    "events.iterate.com/project/created",
    "events.iterate.com/repo/create-requested",
    "events.iterate.com/stream/subscription-configured",
  ],
});
