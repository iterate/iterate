// src/project/contract.ts — A PROJECT: the context at `/`. Its facts live on that root log, and THIS
// FILE is the only place they are spelled. The `project` facet hosted there is the catalog host — the
// collections hang off it (`itx.repos`, `itx.workspaces`: collection.ts, one per
// entity on src/project/durable-object.ts) — and the project is itself a domain object with a
// creation saga: `session.projects.create` writes the control-plane database's row, then (session.ts,
// the same verb) enables the `project` processor on `/` and appends `project/create-requested`;
// processor.ts runs the saga from state at head
// and lands `project/created` or `project/create-failed`; the dash renders the state live. The rest
// of the folder derives from here: processor.ts reduces these events, durable-object.ts hosts the
// processor and the collections. Every type is derived here, never hand-kept:
//   ProjectState                        = ProcessorState<typeof ProjectContract>  the reduced state below
//   ConsumedEvent<typeof ProjectContract>                                          what reduce and processEvent see
import { z } from "zod";
import { defineProcessorContract, type ProcessorState } from "iterate/stream/processor";
import { RepoContract } from "../repo/contract.ts";
import { WorkspaceContract } from "../workspace/contract.ts";
import { SecretCatalog, SecretContract } from "../secret/contract.ts";
import { CoreEventCatalog } from "../stream/core-events.ts";
import {
  INTEGRATION_TRUST,
  IntegrationConnectionRow,
  IntegrationEventCatalog,
} from "../integrations/contract.ts";

/** Where a custom hostname stands at Cloudflare (custom-hostnames.ts reads it off the API). */
export const CustomHostnameObservation = z.object({
  /** Cloudflare's hostname status: `pending` until the CNAME is seen, then `active`. */
  status: z.string(),
  /** The certificate's status: `pending_validation` … `active`. */
  sslStatus: z.string(),
  /** The CNAMEs the owner adds (custom-hostnames.ts `customHostnameRecords`). */
  records: z.array(z.object({ name: z.string(), value: z.string() })),
});
export type CustomHostnameObservation = z.infer<typeof CustomHostnameObservation>;

export const ProjectContract = defineProcessorContract({
  slug: "project",
  // A checkpoint reduced under an older version is reused as-is by the engine, so bumping the version
  // is what re-reduces every existing root log.
  version: "14",
  description:
    "The project: where its own creation and deletion stand, its custom hostnames, its integration connections, every context under it (from the announcements each lands on /), and the catalog of every repo, workspace and secret born under it (from the certificates cross-posted to /).",
  /** THE REDUCED STATE — what the reduce keeps between events: where the project's OWN creation
   *  stands, as the OFFSET of the event that says so (the request, the certificate, or the failure —
   *  read that event for the error), and the CATALOG of what exists under it — read by each
   *  collection's `list()` and rendered by the dash from `liveSnapshot()`. */
  stateSchema: z.object({
    creation: z
      .object({
        status: z.enum(["requested", "created", "failed"]),
        offset: z.number().int().positive(),
        configRepoTemplate: z.string().optional(),
      })
      .nullable()
      .default(null),
    /** The project's DELETION, asked for by the platform at this offset: the saga is destroying it,
     *  its root last. Null while the project lives. */
    deletion: z.object({ offset: z.number().int().positive() }).nullable().default(null),
    /** Every repo born under the project, by its context path. */
    repos: z.record(z.string(), z.object({ createdAt: z.string() })).default({}),
    /** Every workspace born under the project, by path. */
    workspaces: z.record(z.string(), z.object({ createdAt: z.string() })).default({}),
    /** THE CONTEXT REGISTRY: every context under the project, by path, from the
     *  `itx/child-created` each one lands on `/` when it first wakes. `/` itself is not in it. */
    contexts: z.record(z.string(), z.object({ createdAt: z.string() })).default({}),
    /** The project secret catalog. */
    secrets: SecretCatalog.default({}),
    /** The config repo's tip as its commits reach `/`: the latest `repo/commit-completed` from
     *  `/repos/config` — the commit the apex follows — by its oid (what the ingress target names) and
     *  the OFFSET of the fact (the publication the processor owes for it). Null until the seed. */
    configRepoTip: z
      .object({ commitOid: z.string().min(1), offset: z.number().int().positive() })
      .nullable()
      .default(null),
    /** The config repo's commit the apex was last pointed at: the latest `itx/ingress-configured`
     *  whose target is the one the processor writes for a commit (processor.ts
     *  `configRepoIngressTarget`). The publication the tip owes is done once this is the tip's
     *  commit. A target set by hand, or none, leaves it as it was. Null until the first. */
    publishedCommitOid: z.string().min(1).nullable().default(null),
    /** The offset of the `itx/ingress-configured` that published it: a tip is published only by one
     *  after its fact, since a pull can return main to a commit published before. */
    publishedAt: z.number().int().nullable().default(null),
    /** THE CUSTOM HOSTNAMES (custom-hostnames.ts), by hostname: the request the processor owes (an
     *  add — which is also a re-check — or a remove, by the OFFSET of the request), Cloudflare's last
     *  observation (null until provisioned), and the last failure's words. */
    hostnames: z
      .record(
        z.string(),
        z.object({
          requested: z
            .object({ verb: z.enum(["add", "remove"]), offset: z.number().int().positive() })
            .nullable(),
          cloudflare: CustomHostnameObservation.nullable(),
          error: z.string().nullable(),
        }),
      )
      .default({}),
    /** THE INTEGRATION CONNECTIONS, by the connection's log path: the platform's `<provider>/connected`
     *  facts, a `disconnected` dropping its row. */
    integrations: z.record(z.string(), IntegrationConnectionRow).default({}),
    /** THE PRIMARY HOSTNAME: one of `hostnames`, live (Cloudflare's hostname and certificate both
     *  `active`), that `itx.url` composes the project's URLs on and the edge redirects a navigation
     *  on the ingress base to (worker.ts). Null when none; cleared when the hostname's removal is
     *  asked or it stops being live. Published to the control plane (processor.ts). */
    primaryHostname: z.string().nullable().default(null),
  }),
  events: {
    "events.iterate.com/project/create-requested": {
      description:
        "Someone asked for this project (`session.projects.create`). The payload is the directory row's facts — the slug and the organization — so the log is self-describing. The processor lands created or create-failed; a request after the certificate is a harmless fact.",
      payloadSchema: z.object({
        slug: z.string().min(1),
        orgId: z.string().min(1),
        configRepoTemplate: z.string().optional(),
      }),
    },
    "events.iterate.com/project/created": {
      description:
        "The birth certificate: existence only, on `/` — the context it lands on IS the project.",
      payloadSchema: z.object({}),
    },
    "events.iterate.com/project/create-failed": {
      description: "What provisioning reported. Terminal until a new request.",
      payloadSchema: z.object({ error: z.string() }),
    },
    "events.iterate.com/project/delete-requested": {
      description:
        "The project's owner deleted it (`session.projects.delete`): the control plane has already dropped its row, so nothing reaches it any more. The processor destroys every context in the project's registry (deepest first), its custom hostnames, its kv, files and Artifacts repos, lands `project/deleted`, and destroys `/` last. Honoured only as the platform's own fact (`source.platform`): a member can append it, and it does nothing.",
      payloadSchema: z.object({}),
    },
    "events.iterate.com/project/context-deleted": {
      description:
        "One of the project's contexts was destroyed by the deletion saga: its storage, its facets' and its alarm are gone. A record: nothing reads it back.",
      payloadSchema: z.object({ path: z.string().min(1) }),
    },
    "events.iterate.com/project/delete-failed": {
      description:
        "A deletion pass failed three times over (the saga retries after 5 s and 30 s): the error. The saga stops in this incarnation, and a later one starts it again. A record: nothing reads it back.",
      payloadSchema: z.object({ error: z.string() }),
    },
    "events.iterate.com/project/deleted": {
      description:
        "Every context but `/`, the custom hostnames, kv, files and Artifacts repos are gone; `/` itself is destroyed next. A record: nothing reads it back.",
      payloadSchema: z.object({}),
    },
    "events.iterate.com/project/hostname-add-requested": {
      description:
        "Serve this project on `hostname` — its apex there, and `<routingSlug>.<hostname>` with that routing slug. The processor claims it in the control plane's hostname table and creates the wildcard Cloudflare for SaaS custom hostname, then lands hostname-add-settled. Again for a hostname already added re-reads Cloudflare's status.",
      payloadSchema: z.object({ hostname: z.string().min(1) }),
    },
    "events.iterate.com/project/hostname-add-settled": {
      description:
        "The answer to the add at `requestOffset`: Cloudflare's status and the DNS records the owner adds, or why it failed (taken, reserved, malformed, Cloudflare's refusal). A failed first add releases the claim.",
      payloadSchema: z.object({
        hostname: z.string().min(1),
        requestOffset: z.number().int().positive(),
        cloudflare: CustomHostnameObservation.nullable(),
        error: z.string().nullable(),
      }),
    },
    "events.iterate.com/project/hostname-remove-requested": {
      description:
        "Stop serving the project on `hostname`: the processor deletes the custom hostname and releases the claim.",
      payloadSchema: z.object({ hostname: z.string().min(1) }),
    },
    "events.iterate.com/project/hostname-removed": {
      description:
        "The answer to the remove at `requestOffset`: the hostname is no longer the project's.",
      payloadSchema: z.object({
        hostname: z.string().min(1),
        requestOffset: z.number().int().positive(),
      }),
    },
    "events.iterate.com/project/primary-hostname-configured": {
      description:
        "Make `hostname` the project's primary hostname, or clear it with null. Only a live hostname the project holds becomes primary; any other leaves the primary as it was.",
      payloadSchema: z.object({ hostname: z.string().min(1).nullable() }),
    },
  },
  // THE RELATIONSHIP: the project consumes the entities' certificates without owning them, its
  // connections' facts (src/integrations/contract.ts, shared with the account), and the
  // core's apex target (`itx/ingress-configured`), which it both appends and reduces.
  processorDeps: [
    RepoContract,
    WorkspaceContract,
    SecretContract,
    CoreEventCatalog,
    IntegrationEventCatalog,
  ],
  consumes: [
    "events.iterate.com/project/create-requested",
    "events.iterate.com/project/created",
    "events.iterate.com/project/create-failed",
    "events.iterate.com/project/delete-requested",
    "events.iterate.com/itx/child-created",
    "events.iterate.com/project/hostname-add-requested",
    "events.iterate.com/project/hostname-add-settled",
    "events.iterate.com/project/hostname-remove-requested",
    "events.iterate.com/project/hostname-removed",
    "events.iterate.com/project/primary-hostname-configured",
    "events.iterate.com/repo/created",
    "events.iterate.com/workspace/created",
    "events.iterate.com/repo/deleted",
    "events.iterate.com/workspace/deleted",
    "events.iterate.com/secret/set",
    "events.iterate.com/secret/deleted",
    "events.iterate.com/secret/lent",
    "events.iterate.com/secret/borrowed",
    "events.iterate.com/secret/lend-revoked",
    "events.iterate.com/repo/commit-completed",
    "events.iterate.com/itx/ingress-configured",
    "events.iterate.com/itx/child-created",
    "events.iterate.com/slack/connected",
    "events.iterate.com/slack/disconnected",
    "events.iterate.com/google/connected",
    "events.iterate.com/google/disconnected",
    "events.iterate.com/cloudflare/connected",
    "events.iterate.com/cloudflare/disconnected",
    "events.iterate.com/github/connected",
    "events.iterate.com/github/disconnected",
    "events.iterate.com/waitrose/connected",
    "events.iterate.com/waitrose/disconnected",
  ],
  emits: [
    "events.iterate.com/project/created",
    "events.iterate.com/project/create-failed",
    "events.iterate.com/project/context-deleted",
    "events.iterate.com/project/delete-failed",
    "events.iterate.com/project/deleted",
    "events.iterate.com/project/hostname-add-settled",
    "events.iterate.com/project/hostname-removed",
    // the core's: the saga points the project's apex at the seeded config repo's commit, and the
    // processor re-points it at every later commit of the config repo (a commit IS its publication)
    "events.iterate.com/itx/ingress-configured",
  ],
  // WHOM IT LISTENS TO: the platform alone for the project's deletion (the session appends it once
  // the control plane dropped the row), the secrets' catalog (cross-posted by the secrets verbs) and
  // the connections; the entities' certificates certify themselves (iterate/stream/processor);
  // everything else from the trusted — the dash is a member.
  trust: {
    "events.iterate.com/project/delete-requested": "platform",
    "events.iterate.com/secret/set": "platform",
    "events.iterate.com/secret/deleted": "platform",
    "events.iterate.com/secret/lent": "platform",
    "events.iterate.com/secret/borrowed": "platform",
    "events.iterate.com/secret/lend-revoked": "platform",
    ...INTEGRATION_TRUST,
  },
});

/** The project's reduced state: where its creation stands, and the catalog (the contract's
 *  `stateSchema`). */
export type ProjectState = ProcessorState<typeof ProjectContract>;
