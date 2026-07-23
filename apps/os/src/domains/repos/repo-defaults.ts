// Repo creation policy: THE request batch that opens one repo's creation
// saga. Explicit `repos.get(path).create(payload)` and the project bootstrap
// saga (the seeded `/repos/config`) append exactly this batch, so the
// idempotency keys collide by design: whoever appends first wins and every
// retry dedupes. The repo processor then drives the saga to its terminal
// fact — `repos/created` (the birth certificate with the backing Artifacts
// coordinates) or `repos/create-failed` (fail-closed).
//
// The batch deliberately does NOT route the terminal fact to the project
// catalog — that lane is the creator's choice: `repos.get(path).create()`
// arms a dedicated `repos/created` cross-post subscription, while the
// project bootstrap's config repo already has the `cross-post:/` rule that
// copies every post-setup event onto `/`.

import { DurableObjectNameCodec } from "../durable-object-names.ts";
import { buildDurableObjectProcessorSubscriptionConfiguredEvent } from "../streams/utils.ts";
import { REPO_DEFAULT_BRANCH } from "./repo-branch.ts";
import { RepoProcessorContract, type RepoCreateRequest } from "./repo-processor-contract.ts";

export { REPO_DEFAULT_BRANCH } from "./repo-branch.ts";

/** The `repos/create-requested` payload — the creation saga's durable intent. */
export type RepoCreateInput =
  | { type: "empty" }
  | { type: "github-private"; connection: string; owner: string; repo: string }
  | {
      type: "github-public";
      connection: string;
      depth?: number;
      owner: string;
      repo: string;
    };

export function repoCreateInputFromRequest(request: RepoCreateRequest): RepoCreateInput {
  if (request.type === "empty") return request;
  if (request.type === "github-private") {
    return {
      type: request.type,
      connection: request.connection,
      owner: request.owner,
      repo: request.repo,
    };
  }
  return {
    type: request.type,
    connection: request.connection,
    ...(request.depth === undefined ? {} : { depth: request.depth }),
    owner: request.owner,
    repo: request.repo,
  };
}

export function parseRepoCreateInput(input: unknown): RepoCreateInput {
  const requestSchema =
    RepoProcessorContract.events["events.iterate.com/repos/create-requested"].payloadSchema;
  return repoCreateInputFromRequest(requestSchema.parse(input));
}

/**
 * Resolve the external creation request into the saga's durable intent.
 * GitHub's reported default branch is captured before the first event lands,
 * so every retry and processor consequence uses the same branch.
 */
export async function resolveRepoCreateRequest(
  input: RepoCreateInput,
  githubDefaultBranch: (input: Exclude<RepoCreateInput, { type: "empty" }>) => Promise<string>,
): Promise<RepoCreateRequest> {
  const requestSchema =
    RepoProcessorContract.events["events.iterate.com/repos/create-requested"].payloadSchema;
  const parsed = parseRepoCreateInput(input);
  if (parsed.type === "empty") return parsed;
  return requestSchema.parse({
    ...parsed,
    defaultBranch: await githubDefaultBranch(parsed),
  });
}

/**
 * The atomic creation-request batch for one repo: the `repos/create-requested`
 * intent plus the subscription that arms the repo's own processor (which
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
  payload?: RepoCreateRequest;
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
    buildDurableObjectProcessorSubscriptionConfiguredEvent({
      durableObjectName,
      idempotencyKey: `stream/subscription-configured:${durableObjectName}#${RepoProcessorContract.slug}`,
      processor: ["repos", ["get", path], "processor"],
      processorSlug: RepoProcessorContract.slug,
    }),
  ];
}
