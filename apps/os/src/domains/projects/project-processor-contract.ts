import { z } from "zod";
import { defineProcessorContract, type ProcessorState } from "../streams/processor-contracts.ts";
import { CoreProcessorContract } from "../streams/core-processor-contract.ts";
import { RepoProcessorContract } from "../repos/repo-processor-contract.ts";
import { AgentProcessorContract } from "../agents/agent-processor-contract.ts";
import { StreamListItem } from "../streams/schemas.ts";

const ProjectCustomDomainStatus = z.enum([
  "requested",
  "provisioning",
  "pending_validation",
  "active",
  "failed",
  "removing",
]);

const ProjectCustomDomainValidationRecord = z.object({
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

const ProjectCustomDomain = ProjectCustomDomainCloudflareSnapshot.extend({
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type ProjectCustomDomainCloudflareSnapshot = z.output<
  typeof ProjectCustomDomainCloudflareSnapshot
>;

/** One custom domain as reduced onto project processor state. */
export type ProjectCustomDomain = z.output<typeof ProjectCustomDomain>;

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
        /** The creating user's login email, when known. Seeds owner-scoped
         * project state (e.g. the inbound email sender allowlist). */
        creatorEmail: z.string().optional(),
      }),
      examples: [
        {
          description:
            "A dashboard signup created the project: onboarding starts and the creator's email seeds the inbound-email sender allowlist.",
          payload: {
            onboardingActive: true,
            projectId: "prj_01jzp3v9qkfxeb2m4n8r7wd5ha",
            slug: "acme-inc",
            creatorEmail: "jane@acme-inc.com",
          },
        },
        {
          description:
            "An admin/CLI create: no creating user, so no onboarding and no allowlist seed.",
          payload: {
            projectId: "prj_01jzq8t2m5xcnd4w9e6b3vf7kp",
            slug: "acme-staging",
          },
        },
      ],
    },
    "events.iterate.com/project/created": {
      description: "The project root was created.",
      payloadSchema: z.object({
        projectId: z.string(),
        slug: z.string(),
      }),
      examples: [
        {
          description:
            "The bootstrap saga finished: the root repo exists and the project worker answered its probe.",
          payload: {
            projectId: "prj_01jzp3v9qkfxeb2m4n8r7wd5ha",
            slug: "acme-inc",
          },
        },
      ],
    },
    "events.iterate.com/project/onboarding-completed": {
      description: "The project owner completed the onboarding agent flow.",
      payloadSchema: z.object({
        agentPath: z.string(),
      }),
      examples: [
        {
          description: "The onboarding agent marked its flow done for the project owner.",
          payload: {
            agentPath: "/agents/onboarding",
          },
        },
      ],
    },
    "events.iterate.com/project/custom-domain-add-requested": {
      description: "A custom domain should be provisioned and routed to this project.",
      payloadSchema: z.object({
        hostname: z.string(),
      }),
      examples: [
        {
          description: "The owner asked to serve the project on their own domain.",
          payload: {
            hostname: "app.acme-inc.com",
          },
        },
      ],
    },
    "events.iterate.com/project/custom-domain-refresh-requested": {
      description: "Refresh Cloudflare status for a custom domain.",
      payloadSchema: z.object({
        hostname: z.string(),
      }),
      examples: [
        {
          description:
            "A dashboard refresh re-polls Cloudflare while the domain is pending validation.",
          payload: {
            hostname: "app.acme-inc.com",
          },
        },
      ],
    },
    "events.iterate.com/project/custom-domain-remove-requested": {
      description: "A custom domain should be removed from this project.",
      payloadSchema: z.object({
        hostname: z.string(),
      }),
      examples: [
        {
          description: "The owner asked to detach their domain from the project.",
          payload: {
            hostname: "app.acme-inc.com",
          },
        },
      ],
    },
    "events.iterate.com/project/custom-domain-cloudflare-observed": {
      description: "Cloudflare custom-hostname status observed for a project custom domain.",
      payloadSchema: ProjectCustomDomainCloudflareSnapshot,
      examples: [
        {
          description:
            "First observation after provisioning: certificate validation is pending, so the owner still has DNS records to create.",
          payload: {
            cloudflareHostnameId: "0d89c70d-ad9f-4843-b99f-6cc0252067e9",
            error: null,
            hostname: "app.acme-inc.com",
            hostnameStatus: "pending",
            ownershipVerification: {
              name: "_cf-custom-hostname.app.acme-inc.com",
              value: "5cc07c04-ea62-4a5d-b4b0-069bc47533f8",
            },
            sslStatus: "pending_validation",
            status: "pending_validation",
            validationRecords: [
              {
                name: "_acme-challenge.app.acme-inc.com",
                status: "pending",
                value: "ca3-f8e2b4c9d1a04e7f9b6c3d2e1f0a5b4c",
              },
            ],
            wildcard: true,
          },
        },
        {
          description:
            "A later refresh observed the hostname and certificate both active: the domain now routes to the project.",
          payload: {
            cloudflareHostnameId: "0d89c70d-ad9f-4843-b99f-6cc0252067e9",
            error: null,
            hostname: "app.acme-inc.com",
            hostnameStatus: "active",
            ownershipVerification: null,
            sslStatus: "active",
            status: "active",
            validationRecords: [],
            wildcard: true,
          },
        },
      ],
    },
    "events.iterate.com/project/custom-domain-provision-failed": {
      description: "Custom-domain provisioning failed before an observed Cloudflare status.",
      payloadSchema: z.object({
        error: z.string(),
        hostname: z.string(),
      }),
      examples: [
        {
          description: "Cloudflare rejected the custom-hostname create call.",
          payload: {
            error:
              "Cloudflare /zones/f1e2d3c4b5a69788c9d0e1f2a3b4c5d6/custom_hostnames failed with 409: Duplicate custom hostname found.",
            hostname: "app.acme-inc.com",
          },
        },
      ],
    },
    "events.iterate.com/project/custom-domain-removed": {
      description: "A custom domain was removed from Cloudflare and routing KV.",
      payloadSchema: z.object({
        hostname: z.string(),
      }),
      examples: [
        {
          description:
            "The remove request completed: Cloudflare and routing KV no longer know the hostname.",
          payload: {
            hostname: "app.acme-inc.com",
          },
        },
      ],
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

/**
 * The contract's type under the same identifier, so type-level helpers read
 * without `typeof`: `ProcessorState<ProjectProcessorContract>`,
 * `ConsumedEvent<ProjectProcessorContract>`, `ProcessorEvent<ProjectProcessorContract, T>`.
 */
export type ProjectProcessorContract = typeof ProjectProcessorContract;

/**
 * The project processor's reduced state, inferred from the contract's
 * `stateSchema` — the one definition of the shape. `created` flips when the
 * bootstrap saga lands; the list fields are what the collection `list()`
 * methods read.
 */
export type ProjectProcessorState = ProcessorState<ProjectProcessorContract>;
