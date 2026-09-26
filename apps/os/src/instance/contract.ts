// src/instance/contract.ts — THE INSTANCE: the deployment's own record on the global root
// `global:/`, which only the operator reaches (the admin bearer, or a platform admin holding the
// `admin` scope: session.ts `global`). Today it holds one thing: the catalog of the deployment's own
// secrets, `global:/secrets/<name>` — keys the operator sets and lends to projects (one project, or
// every project: context/built-ins.ts `itx.secrets.lend`). processor.ts folds the certificates
// cross-posted here; durable-object.ts hosts it as the first-party facet `instance`
// (first-party-facets.ts). A PURE FOLD.
import { z } from "zod";
import { defineProcessorContract, type ProcessorState } from "iterate/stream/processor";
import { SecretCatalog, SecretContract } from "../secret/contract.ts";

export const InstanceContract = defineProcessorContract({
  slug: "instance",
  version: "1",
  description:
    "The deployment's own record on the global root: the catalog of its secrets and their lends.",
  stateSchema: z.object({
    /** Every secret set at `global:/secrets/<name>` and its live lends (src/secret/contract.ts):
     *  what `itx.secrets.list()` reads here, and what a new project borrows from (every lend whose
     *  `to` is `every-project`). */
    secrets: SecretCatalog.default({}),
  }),
  events: {},
  // THE RELATIONSHIP: the instance consumes its secrets' certificates without owning them
  // (src/secret/contract.ts: cross-posted from `global:/secrets/<name>`).
  processorDeps: [SecretContract],
  consumes: [
    "events.iterate.com/secret/set",
    "events.iterate.com/secret/deleted",
    "events.iterate.com/secret/lent",
    "events.iterate.com/secret/lend-revoked",
  ],
  emits: [],
  // Every fact folded here is the platform's to write (caller.ts `Caller.platform`): an append by the operator's own hand changes nothing.
  trust: { "*": "platform" },
});

/** The instance's reduced state (the contract's `stateSchema`). */
export type InstanceState = ProcessorState<typeof InstanceContract>;
