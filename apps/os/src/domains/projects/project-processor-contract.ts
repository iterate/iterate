// The project processor CONTRACT. Self-contained: state schema, events,
// consumes/emits, deps — and it OWNS every nested data structure (birth
// certificate, custom-domain entry, egress rule, approval payloads);
// consumers reach into this module for pieces, never the other way around.
// Schemas are spelled INLINE in the contract; the ones it genuinely needs
// more than once (the project creation payload, terminal creation facts, and
// the egress rule) are hoisted functions below, so the contract still opens
// the file.
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
import { internalStreamId } from "../streams/stream-delivery-utils.ts";
import { AgentBirthDefaults } from "../agents/agent-defaults.ts";
import { parseConfigRepoTemplateReference } from "../../lib/config-repo-template-reference.ts";
import { ApprovalPresentedEvents } from "./approval-presented-contract.ts";
import { AgentReplyPresentedEvents } from "./agent-reply-presented-contract.ts";
import { StreamContext } from "./stream-context.ts";

/**
 * One client scope in the project's clients catalog: a capability-host scope
 * (typically under /clients/**) that `projects.connect` provided a live
 * capability to, reduced from its copied provider Pager connected/disconnected
 * facts. Presence is last-known: the platform journals the disconnect when
 * the provider's socket dies.
 */
const ProjectClientRecord = z.object({
  path: z.string().meta({ description: "The client's identity — its scope's stream path." }),
  connected: z.boolean().meta({
    description:
      "True while at least one provider Pager is connected on the scope (a reconnect " +
      "overlaps briefly, so this counts sessions, not sockets).",
  }),
  lastConnectedAt: z
    .string()
    .meta({ description: "Source-stream commit time of the newest pager-connected fact." }),
  lastDisconnectedAt: z
    .string()
    .optional()
    .meta({ description: "Source-stream commit time of the newest pager-disconnected fact." }),
  connectedAtOffsets: z
    .array(z.number().int().positive())
    .default([])
    .meta({
      description:
        "Reducer bookkeeping: source-stream offsets of the pager-connected facts still open " +
        "(each pager-disconnected names the connectedAtOffset it closes). `connected` is " +
        "this set's non-emptiness.",
    }),
});
/** The clients-catalog fold record (includes reducer bookkeeping). */
export type ProjectClientRecord = z.infer<typeof ProjectClientRecord>;

/** What `itx.clients.list()` returns per client: the catalog record minus reducer bookkeeping. */
export type ProjectClientListItem = Omit<ProjectClientRecord, "connectedAtOffsets">;

export const ProjectProcessorContract = defineProcessorContract({
  slug: "project",
  version: "0.7.0",
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
    clients: z
      .record(z.string(), ProjectClientRecord)
      .default({})
      .meta({
        description:
          "Catalog of client scopes keyed by path, recorded from copied capability-host " +
          "provider Pager connected/disconnected facts (each projects.connect's birth batch " +
          "configures the clients-to-root copy subscription); what itx.clients.list() reads. " +
          "Last-known presence: the platform journals the disconnect when a provider's " +
          "socket dies, so `connected` is honest to socket death, not merely to polite " +
          "goodbyes.",
      }),
    customDomains: z
      .array(
        z.object({
          hostname: z.string().meta({ description: "The custom hostname." }),
          kind: z.enum(["cloudflare", "direct"]).meta({
            description:
              "`cloudflare` is provisioned through Cloudflare for SaaS; `direct` is a " +
              "platform-owned hostname already covered by a Worker route.",
          }),
        }),
      )
      .default([])
      .meta({
        description:
          "A small display/export catalog. The hostname KV directory, not this state, is the " +
          "routing authority.",
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
    agentBirthDefaults: AgentBirthDefaults.nullable()
      .default(null)
      .meta({
        description:
          "The project's standing contribution to matching agent birth batches: the LATEST " +
          "project/agent-birth-defaults-configured payload, with each birth event validated " +
          "against the agent-consumed vocabulary at fold time. A malformed latest payload folds " +
          "to null (degrade to platform-default births, never to stale defaults). What the " +
          "agent creation door reads.",
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
    "events.iterate.com/project/agent-birth-defaults-configured": {
      description:
        "The project's config worker declares birth defaults for agents born through the " +
        "generic creation door: a list of plain agent-vocabulary events (a prompt is a keyed " +
        "agents/context-added, a driver choice an agent/configured, a processor attachment an " +
        "allowlisted stream/subscription-configured) appended into every matching birth batch " +
        "with platform-minted content-hash idempotency keys. Latest occurrence wins; explicit " +
        "call-site policies (integration routers) outrank it.",
      payloadSchema: AgentBirthDefaults,
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
    "events.iterate.com/project/custom-domain-remove-requested": {
      description: "A custom domain should be removed from this project.",
      payloadSchema: z.object({
        hostname: z.string().meta({ description: "The hostname to detach from the project." }),
      }),
    },
    "events.iterate.com/project/custom-domain-configured": {
      description:
        "The hostname is configured and its KV routing registration points at this project.",
      payloadSchema: z.object({
        hostname: z.string().meta({ description: "The configured hostname." }),
        kind: z.enum(["cloudflare", "direct"]).meta({
          description: "Whether Cloudflare for SaaS or a direct Worker route serves it.",
        }),
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
        "match allows): a `hold` verdict parks the request in an approval batch until a human " +
        "decides it on this stream, `deny` refuses it outright.",
      payloadSchema: z.object({
        rules: z
          .array(egressRuleSchema())
          .meta({ description: "The complete ordered rule list now in force." }),
      }),
    },
    "events.iterate.com/project/human-approval-key-added": {
      description:
        "Enroll a public key whose holder may approve held egress batches. Once any active key " +
        "exists, decisions containing any `approve` verdict MUST carry a valid ECDSA P-256 " +
        "signature over the canonical approval message (approval.v2) — unsigned approvals are " +
        "ignored. All-reject decisions never require a signature.",
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
        "A batch of outbound requests matched one `hold` rule and is parked at the egress door " +
        "awaiting a human — a lone request is a batch of one. Everything is placeholder form — " +
        "getSecret(...) references, never material. The requested event's offset IS the batch's " +
        "identity: the decision references it as approvalRequestEventOffset, and each request's " +
        "position in `requests` is its index within the batch.",
      payloadSchema: z.object({
        requests: z
          .array(
            z.object({
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
                    "A bounded inspection prefix in placeholder form plus the complete body's " +
                    "SHA-256.",
                }),
              secretPaths: z.array(z.string()).default([]).meta({
                description:
                  'Secret paths the request references — the "spends this secret" headline.',
              }),
            }),
          )
          .min(1)
          .meta({
            description:
              "The held requests, in arrival order. Index within this array is each request's " +
              "identity inside the batch (verdicts and settlements refer to it).",
          }),
        ruleKey: z.string().meta({ description: "The one rule that caught every request here." }),
        ruleDescription: z.string().default("").meta({
          description: "The matched rule's human-readable explanation, snapshotted at gate time.",
        }),
        streamContext: StreamContext.optional().meta({
          description:
            "Host-minted durable stream context for the invocation that attempted these " +
            "requests. Batches with 2+ requests always carry script-execution provenance — " +
            "only one script run's concurrent burst at one rule ever coalesces.",
        }),
        expiresAt: z.string().meta({
          description: "ISO horizon after which the whole batch auto-rejects as expired.",
        }),
      }),
    },
    "events.iterate.com/project/human-approval-decided": {
      description:
        "THE verdict on a held batch — one event decides every request in it, by index. When the " +
        "project has active approval keys, a decision containing any `approve` verdict must carry " +
        "`keyId` + `signature` (raw 64-byte r‖s ECDSA P-256 over the canonical approval.v2 " +
        "message, base64) or the whole event is ignored. All-reject decisions never need a " +
        "signature — deny is the fail-safe direction. The door honors the FIRST decided event " +
        "referencing a batch; later ones are ignored.",
      payloadSchema: z.object({
        approvalRequestEventOffset: z.number().int().nonnegative().meta({
          description: "The batch's identity: the offset of its human-approval-requested event.",
        }),
        verdicts: z
          .array(z.enum(["approve", "reject"]))
          .min(1)
          .meta({
            description:
              "One verdict per request, same order as the batch's `requests` array. A count " +
              "mismatch makes the event malformed and ignored.",
          }),
        decidedBy: z.enum(["human", "expiry"]).meta({
          description:
            "Who decided: a human, or the door's own timeout (expiry is always all-reject and " +
            "never signed).",
        }),
        // `.catch(undefined)`: the reason is cosmetic next to the verdicts, so
        // an invalid one (too long, blank) degrades to ABSENT instead of
        // failing the whole payload parse — a malformed reason must never make
        // the door ignore an otherwise-valid decision and strand the hold.
        reason: z
          .string()
          .trim()
          .min(1)
          .max(1_000)
          .optional()
          .catch(undefined)
          .meta({
            description:
              "The human's stated reason, applying to every rejected index in this decision. It " +
              "rides back to the calling script in each rejected fetch's 403 body, so the agent " +
              "can read why and retry with a change. Deliberately NOT covered by the approval.v2 " +
              "signature: rejections never need signatures (deny is the fail-safe direction — " +
              "stream-append access already suffices to veto), so signing the reason would " +
              "protect nothing. Expiry decisions never carry one.",
          }),
        keyId: z
          .string()
          .optional()
          .meta({ description: "The enrolled key that signed this decision." }),
        signature: z.string().optional().meta({
          description:
            "Base64 raw 64-byte r‖s ECDSA P-256 signature over the canonical approval.v2 message.",
        }),
      }),
    },
    "events.iterate.com/project/human-approval-settled": {
      description:
        "What actually happened after one approved request was released: the upstream status, or " +
        "the delivery failure. Approval and outcome are separate facts — audits want both — and " +
        "a batch's released requests finish independently, so each settles on its own.",
      payloadSchema: z.object({
        approvalRequestEventOffset: z.number().int().nonnegative().meta({
          description: "The batch's identity: the offset of its human-approval-requested event.",
        }),
        index: z.number().int().nonnegative().meta({
          description: "Which request in the batch this settlement is about.",
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
    // The push-suppression claim ("the user is already looking at this
    // batch"). Owned here so the root stream's approval vocabulary stays in
    // one contract; the definition itself lives in a standalone catalog
    // (approval-presented-contract.ts) because the device contract must
    // consume it and cannot import this module back (this module imports the
    // device contract).
    ...ApprovalPresentedEvents,
    // Same arrangement for the chat-reply suppression claim ("the user is
    // already looking at this reply") — standalone catalog, owned here.
    ...AgentReplyPresentedEvents,
  },
  consumes: [
    "*",
    "events.iterate.com/project/egress-rules-configured",
    "events.iterate.com/project/human-approval-key-added",
    "events.iterate.com/project/human-approval-key-revoked",
    "events.iterate.com/project/human-approval-requested",
    "events.iterate.com/project/custom-domain-add-requested",
    "events.iterate.com/project/custom-domain-configured",
    "events.iterate.com/project/custom-domain-provision-failed",
    "events.iterate.com/project/custom-domain-remove-requested",
    "events.iterate.com/project/custom-domain-removed",
    "events.iterate.com/project/onboarding-completed",
    "events.iterate.com/project/agent-birth-defaults-configured",
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
    "events.iterate.com/capability-host/capability-provider-pager-connected",
    "events.iterate.com/capability-host/capability-provider-pager-disconnected",
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
    "events.iterate.com/project/custom-domain-configured",
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
    left.config.creatorEmail === right.config.creatorEmail &&
    left.config.configRepoTemplate === right.config.configRepoTemplate
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
 * The canonical idempotency key is in the stream's platform-only namespace:
 * public appends reject it before idempotency lookup, while the Project
 * Durable Object commits it through the server-only append path. The payload
 * then binds that platform fact to the exact open request.
 */
export function parseProjectCreationTerminal(input: {
  event: StreamEvent;
  projectId: string;
  request: ProjectCreationRequest;
  requestOffset: number;
}): ProjectCreationTerminal | null {
  const { event, projectId, request, requestOffset } = input;
  if (event.path !== "/" || event.source?.copiedFrom) {
    return null;
  }

  switch (event.type) {
    case "events.iterate.com/project/created": {
      if (
        event.idempotencyKey !== internalStreamId("project-creation-terminal", projectId, "created")
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
        event.idempotencyKey !== internalStreamId("project-creation-terminal", projectId, "failed")
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

/** One egress approval rule as reduced onto project processor state. */
export type EgressRule = ProjectProcessorState["egressRules"][number];

/** One enrolled approval public key as reduced onto project processor state. */
export type HumanApprovalKey = ProjectProcessorState["humanApprovalKeys"][number];

/** The complete human-approval-requested event payload — a batch; approval.v2 signs its request-subject fields plus the verdicts. */
export type HumanApprovalRequestedPayload = z.output<
  (typeof ProjectProcessorContract.events)["events.iterate.com/project/human-approval-requested"]["payloadSchema"]
>;

/** One held request inside a batch. */
export type HeldRequest = HumanApprovalRequestedPayload["requests"][number];

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
        configRepoTemplate: z
          .string()
          .trim()
          .min(1)
          .refine(
            (value) => {
              try {
                parseConfigRepoTemplateReference(value);
                return true;
              } catch {
                return false;
              }
            },
            { message: "Invalid public GitHub config template reference." },
          )
          .optional()
          .meta({
            description:
              "Canonical public GitHub reference copied into /repos/config at project birth; " +
              "omit for Iterate's embedded default.",
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
      description: "How long a held batch waits for a human before auto-rejecting.",
    }),
    debounceMs: z
      .number()
      .int()
      .nonnegative()
      .max(60_000)
      .nullable()
      .default(100)
      .meta({
        description:
          "How long the egress door waits for more of a script run's concurrent requests before " +
          "committing them as ONE approval batch (each arrival extends the wait, capped at 3x). " +
          "Only concurrent requests can ever coalesce — a sequential caller's next request starts " +
          "after the previous one is approved — so the default 100ms covers Promise.all bursts. " +
          "null disables batching: every request becomes its own batch of one.",
      }),
  });
}
