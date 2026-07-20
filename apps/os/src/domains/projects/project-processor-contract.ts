import { z } from "zod";
import { defineProcessorContract, type ProcessorState } from "iterate/processors";
import { StreamListItem } from "iterate/processors";
import { CoreProcessorContract } from "../streams/core-processor-contract.ts";
import { RepoProcessorContract } from "../repos/repo-processor-contract.ts";
import { EmailProcessorContract } from "../email/email-processor-contract.ts";
import { SecretProcessorContract } from "../secrets/secret-processor-contract.ts";
import { CapabilityHostProcessorContract } from "../capability-host/capability-host-processor-contract.ts";
import { SchedulerProcessorContract } from "../scheduler/scheduler-processor-contract.ts";
import { DeviceProcessorContract } from "../devices/device-processor-contract.ts";
import { NotificationLifecycleContract } from "../notifications/notification-lifecycle-contract.ts";
import {
  EgressRule,
  HumanApprovalGrantedPayload,
  HumanApprovalKey,
  HumanApprovalRejectedPayload,
  HumanApprovalRequestedPayload,
  HumanApprovalSettledPayload,
} from "./egress-approvals.ts";

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

const ProjectBirthCertificate = z.object({
  config: z.object({
    slug: z.string(),
    onboardingActive: z.boolean().optional(),
    /** The creating user's login email, when known. Seeds owner-scoped
     * project state such as the inbound email sender allowlist. */
    creatorEmail: z.string().optional(),
  }),
});

export const ProjectProcessorContract = defineProcessorContract({
  slug: "project",
  version: "0.2.0",
  description:
    "Project projection: bootstrap the default repo/project worker and manage custom-domain routing.",
  stateSchema: z.object({
    birthCertificate: ProjectBirthCertificate.nullable().default(null),
    ready: z.boolean().default(false),
    onboardingActive: z.boolean().default(false),
    onboardingCompletedAt: z.string().nullable().default(null),
    devices: z.array(StreamListItem).default([]),
    repos: z.array(StreamListItem).default([]),
    secrets: z.array(StreamListItem).default([]),
    streams: z.array(StreamListItem).default([]),
    customDomains: z.array(ProjectCustomDomain).default([]),
    /** Egress approval rules, replaced wholesale by egress-rules-configured. */
    egressRules: z.array(EgressRule).default([]),
    /** Enrolled human-approval public keys; once any is active, grants must be signed. */
    humanApprovalKeys: z.array(HumanApprovalKey).default([]),
    notificationReady: z.boolean().default(false),
  }),
  events: {
    "events.iterate.com/project/created": {
      description: "Birth certificate for this project processor.",
      payloadSchema: ProjectBirthCertificate,
      examples: [
        {
          description:
            "A dashboard signup created the project: onboarding starts and the creator's email seeds the inbound-email sender allowlist.",
          payload: {
            config: {
              onboardingActive: true,
              slug: "acme-inc",
              creatorEmail: "jane@acme-inc.com",
            },
          },
        },
        {
          description:
            "An admin/CLI create: no creating user, so no onboarding and no allowlist seed.",
          payload: {
            config: { slug: "acme-staging" },
          },
        },
      ],
    },
    "events.iterate.com/project/ready": {
      description: "The project bootstrap saga completed and its default worker is ready.",
      payloadSchema: z.object({}),
      examples: [
        {
          description:
            "The bootstrap saga finished: the root repo exists and the project worker answered its probe.",
          payload: {},
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
    "events.iterate.com/project/egress-rules-configured": {
      description:
        "Replace the project's egress approval rules wholesale. Every outbound request is matched " +
        "against the ordered list at the Project DO's egress decision point (first match wins, no " +
        "match allows): a `hold` verdict parks the request until a human grants or rejects it on " +
        "this stream, `deny` refuses it outright.",
      payloadSchema: z.object({
        rules: z.array(EgressRule),
      }),
      examples: [
        {
          description:
            "Mutating Stripe calls need a human; anything spending the production Stripe secret is held too, wherever it goes.",
          payload: {
            rules: [
              {
                ruleKey: "stripe-mutations",
                description: "Mutating calls to the Stripe API",
                match: { hosts: ["api.stripe.com"], methods: ["POST", "PUT", "DELETE"] },
                verdict: "hold",
                approvalTimeoutMs: 600_000,
              },
              {
                ruleKey: "stripe-prod-secret",
                description: "Any request spending the production Stripe key",
                match: { secretPaths: ["/secrets/stripe/prod"] },
                verdict: "hold",
              },
            ],
          },
        },
      ],
    },
    "events.iterate.com/project/human-approval-key-added": {
      description:
        "Enroll a public key whose holder may grant held egress requests. Once any active key " +
        "exists, grants MUST carry a valid ECDSA P-256 signature over the canonical approval " +
        "message (approval.v1) — unsigned grants are ignored. Rejections never require a signature.",
      payloadSchema: z.object({
        keyId: z.string(),
        /** Base64 uncompressed P-256 public point (65 bytes, 0x04‖X‖Y). */
        publicKey: z.string(),
        label: z.string().optional(),
      }),
      examples: [
        {
          description:
            "The owner enrolled their MacBook's Secure Enclave key via `iterate approve --enroll`.",
          payload: {
            keyId: "9f2c47a1b8d3e605",
            publicKey:
              "BGx1uJ9lZ7Yw2cQ4vX8pR3nK6tA1sD5fG0hJ9kL2mN4oP7qS8uV3wY6zB1cE4gI7jM0nQ5rT8vX2yA5bD8fH1kN4pS7u",
            label: "jonas-macbook-enclave",
          },
        },
      ],
    },
    "events.iterate.com/project/human-approval-key-revoked": {
      description: "Revoke an enrolled approval key; signatures from it stop being accepted.",
      payloadSchema: z.object({
        keyId: z.string(),
      }),
      examples: [
        {
          description: "The owner rotated their laptop and revoked the old enclave key.",
          payload: {
            keyId: "9f2c47a1b8d3e605",
          },
        },
      ],
    },
    "events.iterate.com/project/human-approval-requested": {
      description:
        "An outbound request matched a `hold` rule and is parked at the egress door awaiting a " +
        "human. Everything is placeholder form — getSecret(...) references, never material. The " +
        "requested event's offset IS the held request's identity: grants and rejections reference " +
        "it as approvalRequestEventOffset.",
      payloadSchema: HumanApprovalRequestedPayload,
      examples: [
        {
          description:
            "An agent tried to move money: a POST to Stripe spending the production key waits for approval.",
          payload: {
            method: "POST",
            url: "https://api.stripe.com/v1/transfers",
            headers: {
              authorization: 'Bearer getSecret({ path: "/secrets/stripe/prod" })',
              "content-type": "application/x-www-form-urlencoded",
            },
            bodySha256: "9c56cc51b374c3ba189210d5b6d4bf57790d351c96c47c02190ecf1e430ba0aa",
            bodyPreview: "amount=420000&currency=gbp&destination=acct_1MTfjCQ9PRzxCzLK",
            secretPaths: ["/secrets/stripe/prod"],
            ruleKey: "stripe-mutations",
            expiresAt: "2026-07-10T12:34:56.000Z",
          },
        },
      ],
    },
    "events.iterate.com/project/human-approval-granted": {
      description:
        "A human approved a held egress request. When the project has active approval keys, " +
        "`keyId` + `signature` (raw 64-byte r‖s ECDSA P-256 over the canonical approval.v1 " +
        "message, base64) are required and verified before the request is released.",
      payloadSchema: HumanApprovalGrantedPayload,
      examples: [
        {
          description: "A signed grant from an enrolled Secure Enclave key releases the request.",
          payload: {
            approvalRequestEventOffset: 42,
            keyId: "9f2c47a1b8d3e605",
            signature:
              "MEUCIQDx4Zc7HqzUnkl3RaW0mYtVbGJ5cD8fH1kN4pS7uMEUCIQDx4Zc7HqzUnkl3RaW0mYtVbGJ5c=",
          },
        },
      ],
    },
    "events.iterate.com/project/human-approval-rejected": {
      description:
        "A held egress request was refused — by a human, or automatically when its hold expired. " +
        "Rejections are deliberately unsigned: deny is the fail-safe direction.",
      payloadSchema: HumanApprovalRejectedPayload,
      examples: [
        {
          description: "A human refused the request from the approval CLI.",
          payload: {
            approvalRequestEventOffset: 42,
            reason: "human",
          },
        },
        {
          description:
            "Nobody answered within the rule's approvalTimeoutMs; the hold auto-rejected.",
          payload: {
            approvalRequestEventOffset: 42,
            reason: "expired",
          },
        },
      ],
    },
    "events.iterate.com/project/human-approval-settled": {
      description:
        "What actually happened after a granted request was released: the upstream status, or the " +
        "delivery failure. Approval and outcome are separate facts — audits want both.",
      payloadSchema: HumanApprovalSettledPayload,
      examples: [
        {
          description: "The released Stripe transfer succeeded.",
          payload: {
            approvalRequestEventOffset: 42,
            status: 200,
          },
        },
        {
          description: "The upstream call failed after release.",
          payload: {
            approvalRequestEventOffset: 42,
            error: "connection refused",
          },
        },
      ],
    },
  },
  consumes: [
    "*",
    "events.iterate.com/project/egress-rules-configured",
    "events.iterate.com/project/human-approval-key-added",
    "events.iterate.com/project/human-approval-key-revoked",
    "events.iterate.com/project/human-approval-requested",
    "events.iterate.com/project/custom-domain-add-requested",
    "events.iterate.com/project/custom-domain-cloudflare-observed",
    "events.iterate.com/project/custom-domain-provision-failed",
    "events.iterate.com/project/custom-domain-refresh-requested",
    "events.iterate.com/project/custom-domain-remove-requested",
    "events.iterate.com/project/custom-domain-removed",
    "events.iterate.com/project/onboarding-completed",
    "events.iterate.com/project/created",
    "events.iterate.com/project/ready",
    "events.iterate.com/device/created",
    "events.iterate.com/repo/created",
    "events.iterate.com/repo/ready",
    "events.iterate.com/repos/created",
    "events.iterate.com/secret/created",
    "events.iterate.com/stream/created",
    "events.iterate.com/stream/child-stream-created",
    "events.iterate.com/notification/created",
  ],
  processorDeps: [
    CoreProcessorContract,
    RepoProcessorContract,
    EmailProcessorContract,
    SecretProcessorContract,
    CapabilityHostProcessorContract,
    SchedulerProcessorContract,
    DeviceProcessorContract,
    NotificationLifecycleContract,
  ],
  emits: [
    // Seeded onto /integrations/email at project birth (the creator's email
    // becomes the sender allowlist's first entry).
    "events.iterate.com/email/sender-allowed",
    "events.iterate.com/email/created",
    "events.iterate.com/capability-host/created",
    "events.iterate.com/scheduler/created",
    "events.iterate.com/project/custom-domain-cloudflare-observed",
    "events.iterate.com/project/custom-domain-provision-failed",
    "events.iterate.com/project/custom-domain-removed",
    "events.iterate.com/project/ready",
    "events.iterate.com/repos/create-requested",
    "events.iterate.com/stream/subscription-configured",
    "events.iterate.com/notification/created",
  ],
});

/**
 * The contract's type under the same identifier, so type-level helpers read
 * without `typeof`: `ProcessorState<ProjectProcessorContract>`,
 * `ConsumedEvent<ProjectProcessorContract>`.
 */
export type ProjectProcessorContract = typeof ProjectProcessorContract;

/**
 * The project processor's reduced state, inferred from the contract's
 * `stateSchema` — the one definition of the shape. `ready` flips when the
 * bootstrap saga lands; the list fields are what the collection `list()`
 * methods read.
 */
export type ProjectProcessorState = ProcessorState<ProjectProcessorContract>;
