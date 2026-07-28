// The project processor CONTRACT. Self-contained: state schema, events,
// consumes/emits, deps — and it OWNS every nested data structure (birth
// certificate, custom-domain snapshot, egress rule, approval payloads);
// consumers reach into this module for pieces, never the other way around.
// Schemas are spelled INLINE in the contract; the ones it genuinely needs
// more than once (the project creation payload, the Cloudflare custom-domain
// snapshot, the egress rule) are hoisted functions defined below the contract,
// so the contract still opens the file.
//
// The pure half of the human-approval scheme (rule matching, the canonical
// approval message, signature verification) lives in egress-approvals.ts and
// imports its TYPES from here; the Project DO's egress gate and the
// `iterate approve` CLI both build on that module.

import { z } from "zod";
import {
  defineProcessorContract,
  StreamListItem,
  type ProcessorState,
  type StreamEvent,
} from "iterate/processors";
import { CoreProcessorContract } from "../streams/core-processor-contract.ts";
import { RepoProcessorContract } from "../repos/repo-processor-contract.ts";
import { EmailProcessorContract } from "../email/email-processor-contract.ts";
import { SecretProcessorContract } from "../secrets/secret-processor-contract.ts";
import { CapabilityHostProcessorContract } from "../capability-host/capability-host-processor-contract.ts";
import { SchedulerProcessorContract } from "../scheduler/scheduler-processor-contract.ts";
import { DeviceProcessorContract } from "../devices/device-processor-contract.ts";
import { NotificationLifecycleContract } from "../notifications/notification-lifecycle-contract.ts";
import { StreamContext } from "./stream-context.ts";

export const ProjectProcessorContract = defineProcessorContract({
  slug: "project",
  version: "0.4.0",
  description:
    "Project root: runs the project/create-requested → project/created bootstrap saga, births " +
    "the sibling processors every project gets (root capability host, primary scheduler, config " +
    "repo, email router, notification facet), catalogs the project's streams and domain objects, " +
    "manages custom-domain routing, and holds the egress-approval policy.",
  stateSchema: z.object({
    createRequest: projectCreationPayloadSchema().nullable().default(null).meta({
      description:
        "The durable creation intent, from project/create-requested; null until the saga opens.",
    }),
    createRequestedAtOffset: z
      .number()
      .int()
      .positive()
      .nullable()
      .default(null)
      .meta({
        description:
          "Offset of project/create-requested: the causal link for terminal creation facts and " +
          "the lower bound of the later userspace worker feed.",
      }),
    createFailure: projectCreationFailureSchema()
      .nullable()
      .default(null)
      .meta({
        description:
          "The terminal creation failure, from project/create-failed; a failed project is " +
          "closed for good in this deployment.",
      }),
    birthCertificate: projectBirthCertificateSchema()
      .nullable()
      .default(null)
      .meta({
        description:
          "Existence marker: null until terminal project/created reduces after sibling " +
          "processors exist, the seeded default worker is reachable, and its permanent feed " +
          "has been committed.",
      }),
    onboardingActive: z
      .boolean()
      .default(false)
      .meta({
        description:
          "True while the onboarding agent flow is running for the project owner: set from " +
          "project/create-requested, cleared by project/onboarding-completed.",
      }),
    onboardingCompletedAt: z.string().nullable().default(null).meta({
      description: "createdAt of the project/onboarding-completed event; null until then.",
    }),
    devices: z
      .array(StreamListItem)
      .default([])
      .meta({
        description:
          "Catalog of device streams, recorded from copied device/created facts; what " +
          "the devices collection's list() reads.",
      }),
    repos: z
      .array(StreamListItem)
      .default([])
      .meta({
        description:
          "Catalog of repo streams, recorded from copied repos/created certificates; " +
          "what the repos collection's list() reads.",
      }),
    secrets: z
      .array(StreamListItem)
      .default([])
      .meta({
        description:
          "Catalog of secret streams, recorded from copied secret/created facts; what " +
          "the secrets collection's list() reads.",
      }),
    streams: z
      .array(StreamListItem)
      .default([])
      .meta({
        description:
          "Catalog of the project's physical streams (stream/created and " +
          "stream/child-stream-created facts). Purely physical: a path here never implies any " +
          "processor identity.",
      }),
    customDomains: z
      .array(
        projectCustomDomainCloudflareSnapshotSchema().extend({
          kind: z
            .enum(["cloudflare", "direct"])
            .default("cloudflare")
            .meta({
              description:
                "How the hostname routes: `cloudflare` = a Cloudflare-for-SaaS custom hostname " +
                "this processor provisions and polls; `direct` = a platform-owned apex served " +
                "by worker routes plus an operator-primed hostname-directory registration — " +
                "no provisioning lifecycle, and the provisioner must never touch it.",
            }),
          createdAt: z
            .string()
            .meta({ description: "createdAt of the event that first recorded this hostname." }),
          updatedAt: z
            .string()
            .meta({ description: "createdAt of the newest event that touched this hostname." }),
        }),
      )
      .default([])
      .meta({
        description:
          "The project's custom domains, sorted by hostname: the newest Cloudflare snapshot " +
          "per hostname plus local bookkeeping timestamps.",
      }),
    egressRules: z
      .array(egressRuleSchema())
      .default([])
      .meta({
        description:
          "Egress approval rules in force, replaced wholesale by " +
          "project/egress-rules-configured; the Project DO's egress gate matches every " +
          "outbound request against this ordered list.",
      }),
    humanApprovalKeys: z
      .array(
        z.object({
          keyId: z
            .string()
            .meta({ description: "Fingerprint id: first 16 hex chars of the key's SHA-256." }),
          publicKey: z.string().meta({
            description: "Base64 uncompressed P-256 public point (65 bytes, 0x04‖X‖Y).",
          }),
          label: z
            .string()
            .default("")
            .meta({ description: "Human-readable device label from enrollment; may be empty." }),
          addedAt: z
            .string()
            .meta({ description: "createdAt of the human-approval-key-added event." }),
          revokedAt: z.string().nullable().default(null).meta({
            description:
              "createdAt of the human-approval-key-revoked event; null while the key is active.",
          }),
        }),
      )
      .default([])
      .meta({
        description:
          "Enrolled human-approval public keys; once any is active, grants must be signed.",
      }),
    notificationReady: z.boolean().default(false).meta({
      description:
        "True once the notification/created fact from the atomic project birth batch reduces.",
    }),
  }),
  events: {
    "events.iterate.com/project/create-requested": {
      description:
        "Requests the project creation saga. The terminal project/created certificate is " +
        "appended only after sibling processors exist, the seeded default worker has built and " +
        "answered its readiness probe, and its permanent root feed has been installed.",
      payloadSchema: projectCreationPayloadSchema(),
    },
    "events.iterate.com/project/created": {
      description:
        "The project creation saga completed: sibling processors exist, the seeded default " +
        "project worker is reachable, and its permanent root feed is installed. This is a " +
        "platform certificate, not a userspace lifecycle hook.",
      payloadSchema: projectBirthCertificateSchema(),
    },
    "events.iterate.com/project/create-failed": {
      description:
        "The project creation saga reached a deterministic terminal failure and did not declare " +
        "the project created. Transient availability and timeout failures remain open for durable " +
        "redelivery. Fail-closed: nothing else reacts on the failed project stream.",
      payloadSchema: projectCreationFailureSchema(),
    },
    "events.iterate.com/project/worker-updated": {
      description:
        "The platform successfully built, loaded, and probed the current default project " +
        "worker, during creation or after a later config repo commit. This is the userspace " +
        "configuration lifecycle hook; the raw trusted seed commit is not translated.",
      payloadSchema: z.object({
        commitOid: z.string().trim().min(1).meta({
          description: "The config-repo commit associated with the readiness certificate.",
        }),
      }),
    },
    "events.iterate.com/project/worker-update-failed": {
      description:
        "A post-creation config repo commit deterministically failed to build as the default " +
        "project worker. A later config commit can repair it; transient availability remains " +
        "open for redelivery.",
      payloadSchema: z.object({
        commitOid: z.string().trim().min(1).meta({
          description: "The config-repo commit that triggered the failed readiness check.",
        }),
        error: z.string().trim().min(1).meta({
          description: "The deterministic worker build failure.",
        }),
      }),
    },
    "events.iterate.com/project/heartbeat-triggered": {
      description:
        "A project-owned Scheduler heartbeat fired. Userspace handles this lifecycle event " +
        "directly in the config worker.",
      payloadSchema: z.object({
        scheduleKey: z
          .string()
          .min(1)
          .meta({ description: "The scheduler key whose heartbeat fired." }),
      }),
    },
    "events.iterate.com/project/onboarding-completed": {
      description: "The project owner completed the onboarding agent flow.",
      payloadSchema: z.object({
        agentPath: z
          .string()
          .meta({ description: "Stream path of the onboarding agent that finished the flow." }),
      }),
    },
    "events.iterate.com/project/custom-domain-add-requested": {
      description: "A custom domain should be provisioned and routed to this project.",
      payloadSchema: z.object({
        hostname: z
          .string()
          .meta({ description: "The DNS hostname to provision, e.g. app.acme-inc.com." }),
      }),
    },
    "events.iterate.com/project/custom-domain-refresh-requested": {
      description: "Refresh Cloudflare status for a custom domain.",
      payloadSchema: z.object({
        hostname: z.string().meta({ description: "The already-configured hostname to re-poll." }),
      }),
    },
    "events.iterate.com/project/custom-domain-remove-requested": {
      description: "A custom domain should be removed from this project.",
      payloadSchema: z.object({
        hostname: z.string().meta({ description: "The hostname to detach from the project." }),
      }),
    },
    "events.iterate.com/project/custom-domain-cloudflare-observed": {
      description: "Cloudflare custom-hostname status observed for a project custom domain.",
      payloadSchema: projectCustomDomainCloudflareSnapshotSchema(),
    },
    "events.iterate.com/project/custom-domain-direct-observed": {
      description:
        "The hostname routes to this project directly: a platform-owned apex served by worker " +
        "routes plus an operator-primed hostname-directory registration, with no " +
        "Cloudflare-for-SaaS custom hostname behind it. Appended by platform operators, never by " +
        "this processor; recording it keeps the settings UI honest without starting any " +
        "provisioning lifecycle — add/refresh/remove requests for a direct hostname are inert.",
      payloadSchema: z.object({
        hostname: z
          .string()
          .meta({ description: "The directly routed hostname, e.g. iterate.com." }),
      }),
    },
    "events.iterate.com/project/custom-domain-provision-failed": {
      description: "Custom-domain provisioning failed before an observed Cloudflare status.",
      payloadSchema: z.object({
        error: z.string().meta({ description: "What the provisioning attempt reported." }),
        hostname: z.string().meta({ description: "The hostname the attempt was for." }),
      }),
    },
    "events.iterate.com/project/custom-domain-removed": {
      description: "A custom domain was removed from Cloudflare and routing KV.",
      payloadSchema: z.object({
        hostname: z.string().meta({ description: "The hostname that no longer routes here." }),
      }),
    },
    "events.iterate.com/project/egress-rules-configured": {
      description:
        "Replace the project's egress approval rules wholesale. Every outbound request is matched " +
        "against the ordered list at the Project DO's egress decision point (first match wins, no " +
        "match allows): a `hold` verdict parks the request until a human grants or rejects it on " +
        "this stream, `deny` refuses it outright.",
      payloadSchema: z.object({
        rules: z
          .array(egressRuleSchema())
          .meta({ description: "The complete ordered rule list now in force." }),
      }),
    },
    "events.iterate.com/project/human-approval-key-added": {
      description:
        "Enroll a public key whose holder may grant held egress requests. Once any active key " +
        "exists, grants MUST carry a valid ECDSA P-256 signature over the canonical approval " +
        "message (approval.v1) — unsigned grants are ignored. Rejections never require a signature.",
      payloadSchema: z.object({
        keyId: z
          .string()
          .meta({ description: "Fingerprint id: first 16 hex chars of the key's SHA-256." }),
        publicKey: z.string().meta({
          description: "Base64 uncompressed P-256 public point (65 bytes, 0x04‖X‖Y).",
        }),
        label: z
          .string()
          .optional()
          .meta({ description: "Human-readable device label, e.g. the enrolling machine." }),
      }),
    },
    "events.iterate.com/project/human-approval-key-revoked": {
      description: "Revoke an enrolled approval key; signatures from it stop being accepted.",
      payloadSchema: z.object({
        keyId: z.string().meta({ description: "The enrolled key to stop accepting." }),
      }),
    },
    "events.iterate.com/project/human-approval-requested": {
      description:
        "An outbound request matched a `hold` rule and is parked at the egress door awaiting a " +
        "human. Everything is placeholder form — getSecret(...) references, never material. The " +
        "requested event's offset IS the held request's identity: grants and rejections reference " +
        "it as approvalRequestEventOffset.",
      payloadSchema: z.object({
        method: z.string().meta({ description: "HTTP method of the held request." }),
        url: z.string().meta({ description: "Destination URL of the held request." }),
        headers: z.record(z.string(), z.string()).meta({
          description: "All headers as they would be forwarded, placeholder form.",
        }),
        body: z
          .object({
            encoding: z.enum(["utf8", "base64"]),
            content: z.string(),
            originalByteLength: z.number().int().nonnegative().optional(),
            sha256: z.string(),
            truncated: z.boolean().default(false),
          })
          .nullish()
          .meta({
            description:
              "A bounded inspection prefix in placeholder form plus the complete body's SHA-256.",
          }),
        secretPaths: z.array(z.string()).default([]).meta({
          description: 'Secret paths the request references — the "spends this secret" headline.',
        }),
        ruleKey: z.string().meta({ description: "The rule that caught the request." }),
        ruleDescription: z.string().default("").meta({
          description: "The matched rule's human-readable explanation, snapshotted at gate time.",
        }),
        streamContext: StreamContext.optional().meta({
          description:
            "Host-minted durable stream context for the invocation that attempted this request.",
        }),
        expiresAt: z.string().meta({
          description: "ISO horizon after which the hold auto-rejects with reason expired.",
        }),
      }),
    },
    "events.iterate.com/project/human-approval-granted": {
      description:
        "A human approved a held egress request. When the project has active approval keys, " +
        "`keyId` + `signature` (raw 64-byte r‖s ECDSA P-256 over the canonical approval.v1 " +
        "message, base64) are required and verified before the request is released.",
      payloadSchema: z.object({
        approvalRequestEventOffset: z.number().int().nonnegative().meta({
          description:
            "The held request's identity: the offset of its human-approval-requested event.",
        }),
        keyId: z
          .string()
          .optional()
          .meta({ description: "The enrolled key that signed this grant." }),
        signature: z.string().optional().meta({
          description:
            "Base64 raw 64-byte r‖s ECDSA P-256 signature over the canonical approval message.",
        }),
      }),
    },
    "events.iterate.com/project/human-approval-rejected": {
      description:
        "A held egress request was refused — by a human, or automatically when its hold expired. " +
        "Rejections are deliberately unsigned: deny is the fail-safe direction.",
      payloadSchema: z.object({
        approvalRequestEventOffset: z.number().int().nonnegative().meta({
          description:
            "The held request's identity: the offset of its human-approval-requested event.",
        }),
        reason: z
          .enum(["human", "expired"])
          .meta({ description: "Who refused: a human, or the hold's timeout." }),
      }),
    },
    "events.iterate.com/project/human-approval-settled": {
      description:
        "What actually happened after a granted request was released: the upstream status, or the " +
        "delivery failure. Approval and outcome are separate facts — audits want both.",
      payloadSchema: z.object({
        approvalRequestEventOffset: z.number().int().nonnegative().meta({
          description:
            "The held request's identity: the offset of its human-approval-requested event.",
        }),
        status: z
          .number()
          .int()
          .optional()
          .meta({ description: "Upstream HTTP status of the released request." }),
        error: z
          .string()
          .optional()
          .meta({ description: "Delivery failure, when the released request never got a status." }),
      }),
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
    "events.iterate.com/project/custom-domain-direct-observed",
    "events.iterate.com/project/custom-domain-provision-failed",
    "events.iterate.com/project/custom-domain-refresh-requested",
    "events.iterate.com/project/custom-domain-remove-requested",
    "events.iterate.com/project/custom-domain-removed",
    "events.iterate.com/project/onboarding-completed",
    "events.iterate.com/project/create-requested",
    "events.iterate.com/project/created",
    "events.iterate.com/project/create-failed",
    "events.iterate.com/project/worker-updated",
    "events.iterate.com/project/worker-update-failed",
    "events.iterate.com/project/heartbeat-triggered",
    "events.iterate.com/device/created",
    "events.iterate.com/repo/commit-completed",
    "events.iterate.com/repos/created",
    "events.iterate.com/repos/create-failed",
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
    "events.iterate.com/project/created",
    "events.iterate.com/project/create-failed",
    "events.iterate.com/project/worker-updated",
    "events.iterate.com/project/worker-update-failed",
    "events.iterate.com/repos/create-requested",
    "events.iterate.com/stream/subscription-configured",
    "events.iterate.com/stream/subscription-removed",
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
 * `stateSchema` — the one definition of the shape. A non-null
 * `birthCertificate` is the terminal creation marker; the list fields are
 * what the collection `list()` methods read.
 */
export type ProjectProcessorState = ProcessorState<ProjectProcessorContract>;

type ProjectCreationRequest = Pick<NonNullable<ProjectProcessorState["createRequest"]>, "config">;

/** Exact equality for the immutable creation facts carried through the saga. */
function sameProjectCreationRequest(
  left: ProjectCreationRequest,
  right: ProjectCreationRequest,
): boolean {
  return (
    left.config.slug === right.config.slug &&
    left.config.onboardingActive === right.config.onboardingActive &&
    left.config.creatorEmail === right.config.creatorEmail
  );
}

type ProjectCreationTerminal =
  | {
      type: "events.iterate.com/project/created";
      payload: z.output<
        (typeof ProjectProcessorContract.events)["events.iterate.com/project/created"]["payloadSchema"]
      >;
    }
  | {
      type: "events.iterate.com/project/create-failed";
      payload: z.output<
        (typeof ProjectProcessorContract.events)["events.iterate.com/project/create-failed"]["payloadSchema"]
      >;
    };

/**
 * Parse the one terminal fact that can settle a creation request.
 *
 * This is causal validation, not an authorization boundary: processor stamps
 * and idempotency keys are ordinary event claims. The event must be a direct
 * append by this Project processor while consuming the config repo's terminal
 * result, and its payload must settle the exact open request.
 */
export function parseProjectCreationTerminal(input: {
  event: StreamEvent;
  projectId: string;
  request: ProjectCreationRequest;
  requestOffset: number;
}): ProjectCreationTerminal | null {
  const { event, projectId, request, requestOffset } = input;
  const processor = event.source?.processor;
  // The stamped version describes which Project processor originally emitted
  // the fact; it must not be pinned to today's version or a later refold would
  // discard an otherwise valid historical terminal.
  if (
    event.path !== "/" ||
    event.source?.copiedFrom !== undefined ||
    processor === undefined ||
    processor.slug !== ProjectProcessorContract.slug ||
    processor.stream.path !== "/" ||
    processor.stream.projectId !== projectId
  ) {
    return null;
  }

  switch (event.type) {
    case "events.iterate.com/project/created": {
      if (
        event.idempotencyKey !== `project-created:${projectId}` ||
        processor.whileProcessing?.type !== "events.iterate.com/repos/created"
      ) {
        return null;
      }
      const parsed = ProjectProcessorContract.events[
        "events.iterate.com/project/created"
      ].payloadSchema.safeParse(event.payload);
      return parsed.success &&
        parsed.data.createRequestedAtOffset === requestOffset &&
        sameProjectCreationRequest(request, parsed.data)
        ? { type: event.type, payload: parsed.data }
        : null;
    }
    case "events.iterate.com/project/create-failed": {
      if (
        event.idempotencyKey !== "project/create-failed" ||
        (processor.whileProcessing?.type !== "events.iterate.com/repos/created" &&
          processor.whileProcessing?.type !== "events.iterate.com/repos/create-failed")
      ) {
        return null;
      }
      const parsed = ProjectProcessorContract.events[
        "events.iterate.com/project/create-failed"
      ].payloadSchema.safeParse(event.payload);
      return parsed.success &&
        parsed.data.createRequestedAtOffset === requestOffset &&
        sameProjectCreationRequest(request, parsed.data.request)
        ? { type: event.type, payload: parsed.data }
        : null;
    }
    default:
      return null;
  }
}

/** One custom domain as reduced onto project processor state. */
export type ProjectCustomDomain = ProjectProcessorState["customDomains"][number];

/** The Cloudflare custom-hostname snapshot (the custom-domain-cloudflare-observed payload). */
export type ProjectCustomDomainCloudflareSnapshot = z.output<
  (typeof ProjectProcessorContract.events)["events.iterate.com/project/custom-domain-cloudflare-observed"]["payloadSchema"]
>;

/** One egress approval rule as reduced onto project processor state. */
export type EgressRule = ProjectProcessorState["egressRules"][number];

/** One enrolled approval public key as reduced onto project processor state. */
export type HumanApprovalKey = ProjectProcessorState["humanApprovalKeys"][number];

/** The complete human-approval-requested event payload; approval.v1 signs its request-subject fields. */
export type HumanApprovalRequestedPayload = z.output<
  (typeof ProjectProcessorContract.events)["events.iterate.com/project/human-approval-requested"]["payloadSchema"]
>;

/**
 * The payload shared by the creation intent and terminal certificate.
 */
function projectCreationPayloadSchema() {
  return z.object({
    config: z
      .object({
        slug: z
          .string()
          .meta({ description: "The project's URL slug, unique within its organization." }),
        onboardingActive: z.boolean().optional().meta({
          description: "Start the onboarding agent flow for the creating user.",
        }),
        creatorEmail: z
          .string()
          .optional()
          .meta({
            description:
              "The creating user's login email, when known. Seeds owner-scoped project state " +
              "such as the inbound email sender allowlist.",
          }),
      })
      .meta({ description: "Birth-time configuration, recorded verbatim onto state." }),
  });
}

/**
 * The successful terminal certificate. The request offset is an explicit
 * causal link: an old or independently appended birth-shaped fact cannot
 * satisfy the new creation contract.
 */
function projectBirthCertificateSchema() {
  return projectCreationPayloadSchema().extend({
    createRequestedAtOffset: z
      .number()
      .int()
      .positive()
      .meta({ description: "Offset of the project/create-requested event this settles." }),
  });
}

/** The terminal project creation failure, shared by its event and state slot. */
function projectCreationFailureSchema() {
  return z.object({
    createRequestedAtOffset: z
      .number()
      .int()
      .positive()
      .meta({ description: "Offset of the project/create-requested event this settles." }),
    error: z.string().meta({ description: "The terminal bootstrap failure." }),
    request: projectCreationPayloadSchema().meta({
      description: "The project/create-requested intent that could not complete.",
    }),
  });
}

/**
 * The Cloudflare custom-hostname snapshot — used twice (the
 * custom-domain-cloudflare-observed payload and, extended with local
 * timestamps, the reduced state's customDomains entries), so it lives in this
 * hoisted function instead of inline.
 */
function projectCustomDomainCloudflareSnapshotSchema() {
  return z.object({
    cloudflareHostnameId: z.string().nullable().default(null).meta({
      description: "Cloudflare's custom-hostname id; null before the create call succeeded.",
    }),
    error: z.string().nullable().default(null).meta({
      description: "The newest provisioning/validation error Cloudflare reported, if any.",
    }),
    hostname: z.string().meta({ description: "The custom hostname this snapshot describes." }),
    hostnameStatus: z.string().nullable().default(null).meta({
      description: "Cloudflare's raw hostname status (pending, active, …); null when unknown.",
    }),
    ownershipVerification: z
      .object({
        name: z.string().meta({ description: "TXT record name proving hostname ownership." }),
        value: z.string().meta({ description: "TXT record value proving hostname ownership." }),
      })
      .nullable()
      .default(null)
      .meta({
        description:
          "The DNS TXT record the owner must create to prove control; null once verified.",
      }),
    sslStatus: z.string().nullable().default(null).meta({
      description: "Cloudflare's raw certificate status; null when unknown.",
    }),
    status: z
      .enum(["requested", "provisioning", "pending_validation", "active", "failed", "removing"])
      .meta({
        description:
          "Our rollup of the raw statuses: what the dashboard shows and routing acts on. " +
          "Only `active` routes traffic.",
      }),
    validationRecords: z
      .array(
        z.object({
          name: z.string().meta({ description: "TXT record name for certificate validation." }),
          status: z
            .string()
            .nullable()
            .default(null)
            .meta({ description: "Cloudflare's per-record validation status; null when unknown." }),
          value: z.string().meta({ description: "TXT record value for certificate validation." }),
        }),
      )
      .default([])
      .meta({
        description: "DNS records the owner still has to create for certificate validation.",
      }),
    wildcard: z.boolean().default(true).meta({
      description: "Whether the certificate also covers *.<hostname> (we always request it).",
    }),
  });
}

/**
 * One egress approval rule — used twice (the egress-rules-configured payload
 * and the reduced state's egressRules), so it lives in this hoisted function
 * instead of inline.
 */
function egressRuleSchema() {
  return z.object({
    ruleKey: z.string().min(1).meta({
      description: "Caller-provided identifier; the requested event names the rule that caught it.",
    }),
    description: z.string().default("").meta({
      description: 'Human-readable "why was this caught" line, shown on the approval prompt.',
    }),
    match: z
      .object({
        hosts: z.array(z.string()).optional().meta({
          description: 'Hostnames, with `*.` wildcard support: "api.stripe.com", "*.stripe.com".',
        }),
        methods: z.array(z.string()).optional().meta({
          description: 'HTTP methods (case-insensitive): ["POST", "DELETE"].',
        }),
        pathPrefix: z
          .string()
          .optional()
          .meta({ description: 'URL path prefix: "/v1/transfers".' }),
        secretPaths: z
          .array(z.string())
          .optional()
          .meta({
            description:
              "Secret paths the request references (getSecret placeholders). The secret-aware " +
              'trigger: "any request spending /secrets/stripe/prod needs a human", regardless ' +
              "of destination.",
          }),
      })
      .default({})
      .meta({ description: "Matchers of one egress rule. Absent fields match everything." }),
    verdict: z.enum(["hold", "deny"]).meta({
      description: "hold parks the request for a human; deny refuses it outright.",
    }),
    approvalTimeoutMs: z.number().int().positive().max(3_600_000).default(600_000).meta({
      description: "How long a held request waits for a human before auto-rejecting.",
    }),
  });
}
