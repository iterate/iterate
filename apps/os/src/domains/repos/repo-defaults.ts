// Repo creation policy: THE birth batch for one repo stream. Explicit
// `repos.get(path).create(payload)` and the project bootstrap saga (the
// seeded `/repos/config`) append exactly this batch, so the idempotency keys
// collide by design: whoever appends first wins and every retry dedupes.

import type { z } from "zod";
import { DurableObjectNameCodec } from "../durable-object-names.ts";
import { buildDurableObjectProcessorSubscriptionConfiguredEvent } from "../streams/utils.ts";
import { RepoProcessorContract } from "./repo-processor-contract.ts";

/** The `repo/created` payload — the repo's birth certificate. */
export type RepoCreateInput = z.input<
  (typeof RepoProcessorContract.events)["events.iterate.com/repo/created"]["payloadSchema"]
>;

/**
 * The complete atomic creation batch for one repo: the `repo/created` birth
 * certificate plus the subscription that arms the repo's own processor (which
 * seeds the backing Cloudflare Artifacts repository and appends `repo/ready`).
 * Append the whole array in ONE `stream.append` call — the batch commits
 * atomically, so a repo can never exist half-born.
 *
 * The created event's idempotency key is payload-free on purpose: a repeated
 * create with the identical payload dedupes and resolves, while a create over
 * an EXISTING repo with a different payload is rejected by the stream's
 * same-key-different-body rule — the loud duplicate-create failure.
 */
export function repoCreationEvents(input: {
  /** Repo stream path (normalized), e.g. "/repos/config". */
  path: string;
  /** Birth certificate; defaults to `{ config: {} }` (config is reserved). */
  payload?: RepoCreateInput;
  /** null addresses the deployment-wide global repo scope. */
  projectId: string | null;
}) {
  const { path, projectId } = input;
  const durableObjectName = DurableObjectNameCodec.stringify(
    { projectId, path },
    { allowNullProjectId: true },
  );
  return [
    RepoProcessorContract.buildEvent({
      type: "events.iterate.com/repo/created",
      idempotencyKey: `repo-created:${projectId}:${path}`,
      payload: input.payload ?? { config: {} },
    }),
    buildDurableObjectProcessorSubscriptionConfiguredEvent({
      durableObjectName,
      processor: ["repos", ["get", path], "processor"],
      processorSlug: RepoProcessorContract.slug,
    }),
  ];
}
