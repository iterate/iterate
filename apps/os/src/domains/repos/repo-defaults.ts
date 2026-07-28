// Repo creation policy: THE request batch that opens one repo's creation
// saga. Explicit `repos.get(path).create(payload)` and the project bootstrap
// saga (the seeded `/repos/config`) append exactly this batch, so the
// idempotency keys collide by design: whoever appends first wins and every
// retry dedupes. The repo processor then drives the saga to its terminal
// fact — `repos/created` (the birth certificate with the backing Artifacts
// coordinates) or `repos/create-failed` (fail-closed).
//
// The batch deliberately does NOT send the terminal fact to the project
// catalog. `repos.get(path).create()` adds a `repo-catalog` subscription for
// `repos/created`; project bootstrap instead adds `project-config-to-root`,
// which sends every later config-repo event to `/`.

import type { z } from "zod";
import { DurableObjectNameCodec } from "../durable-object-names.ts";
import { buildHostedProcessorSubscriptionConfiguredEvent } from "../streams/utils.ts";
import { RepoProcessorContract } from "./repo-processor-contract.ts";

/** Every creation mode targets this branch — commit and task facts, worker
 * builds, and GitHub mirroring all assume it. */
export const REPO_DEFAULT_BRANCH = "main";

/** The `repos/create-requested` payload — the creation saga's durable intent. */
export type RepoCreateInput = z.input<
  (typeof RepoProcessorContract.events)["events.iterate.com/repos/create-requested"]["payloadSchema"]
>;

/**
 * The atomic creation-request batch for one repo: the `repos/create-requested`
 * intent plus the subscription that wakes the repo's own processor (which
 * drives the saga — seeding or importing the backing Cloudflare Artifacts
 * repository — and appends the terminal `repos/created` / `repos/create-failed`
 * fact). Append the whole array in ONE `stream.append` call — the batch
 * commits atomically, so a repo can never exist half-requested.
 *
 * The request event's idempotency key is payload-free on purpose: a repeated
 * create with the identical payload dedupes and resolves, while a create over
 * an EXISTING repo with a different payload dedupes to the FIRST request —
 * `create()` compares the committed payload against its own and fails loudly
 * on a mismatch.
 */
export function repoCreationEvents(input: {
  /** Repo stream path (normalized), e.g. "/repos/config". */
  path: string;
  /** Creation request; defaults to an empty starter-file repo. */
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
      type: "events.iterate.com/repos/create-requested",
      idempotencyKey: `repo-create-requested:${projectId}:${path}`,
      payload: input.payload ?? { type: "empty" },
    }),
    buildHostedProcessorSubscriptionConfiguredEvent({
      durableObjectName,
      idempotencyKey: `stream/subscription-configured:${durableObjectName}#${RepoProcessorContract.slug}`,
      processor: ["repos", ["get", path], "processor"],
      processorSlug: RepoProcessorContract.slug,
    }),
  ];
}
