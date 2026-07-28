// Linking a repo to a real GitHub repository — the itx-side flow behind
// `itx.repos.get(path).linkGithub(...)`.
//
// A link does three things, in order:
//   1. resolves the named GitHub connection (an App installation) and makes
//      sure the target repository exists — creating it, private, when the
//      installation has permission and it does not;
//   2. adds a durable subscription to the connection stream, so
//      each push webhook about that repository is copied onto the repo's own
//      stream at least once; the command waits until both streams have appended
//      their record of the rule;
//   3. records the link on the Repo Durable Object (KV for the mirror-push hot
//      path + a `repo/github-link-configured` fact on the repo stream).
//
// Unlinking reverses 2 and 3. The mirror pushes themselves live on the Repo
// Durable Object (repo-durable-object.ts), serialized with commits.

import { disposeIgnoredRpcResult } from "iterate/sdk/capnweb";
import { itxEnv } from "../../env.ts";
import { canonicalizeStreamPath, DurableObjectNameCodec } from "../durable-object-names.ts";
import { getConnectionStatus } from "../integrations/connect-flows.ts";
import { connectionOctokit, normalizeGithubError } from "../integrations/github-api.ts";
import { integrationStreamStub } from "../integrations/integration-streams.ts";
import { integrationConnectionStreamPath } from "../integrations/utils.ts";
import type { SubscriptionConfiguredPayload } from "../streams/core-processor-contract.ts";
import type { GithubRepoLink, LinkGithubResult } from "./types.ts";

/** Whether a failed repo-create was GitHub's 422 "name already exists" — the
 * tell that the repository IS there but the installation cannot see it (an App
 * installed with "selected repositories" answers 404 on `GET /repos/...` for
 * unselected repos, so create-on-link runs into the existing name). */
function isGithubNameAlreadyExistsError(error: unknown): boolean {
  const e = error as { message?: string; response?: { data?: unknown }; status?: number };
  if (e.status !== 422) return false;
  const data = e.response?.data;
  const text = typeof data === "string" ? data : JSON.stringify(data ?? "");
  return text.includes("name already exists") || (e.message ?? "").includes("name already exists");
}

/** The one subscription key used for a repo's GitHub webhooks, so
 * re-linking replaces it and unlinking knows what to remove. */
function githubRepoSubscriptionKey(repoPath: string): string {
  return `github-repo:${repoPath}`;
}

/** The subscription that copies one repository's GitHub webhooks from a connection
 * stream to the repo's own stream — built in one place so installation and
 * rollback restore exactly the same rule. The connection stream owns the cursor, retries with backoff,
 * and parks loudly on sustained failure, so webhook copies are at-least-once
 * instead of the old fire-and-forget rule's silent losses. */
function githubRepoSubscription(input: {
  owner: string;
  repo: string;
  repositoryId: number;
  repoPath: string;
  subscriptionKey: string;
}): SubscriptionConfiguredPayload {
  return {
    subscriptionKey: input.subscriptionKey,
    description: `Copies GitHub webhooks for ${input.owner}/${input.repo} onto this repo's stream so default-branch pushes can be imported.`,
    filter: {
      eventTypes: ["events.iterate.com/github/webhook-received"],
      condition: `payload.delivery.name = "push" and payload.body.repository.id = ${input.repositoryId}`,
    },
    receiver: {
      action: "copy-to-stream",
      receivingStreamPath: input.repoPath,
      delivery: {
        start: "now",
        onFailingEvent: "halt",
        includeEphemeral: false,
      },
    },
  };
}

type GithubConnectionStream = ReturnType<typeof integrationStreamStub>;

async function configureGithubWebhookSubscription(
  stream: GithubConnectionStream,
  subscription: SubscriptionConfiguredPayload,
): Promise<void> {
  const result = await stream.setCopySubscription({ configuration: subscription });
  try {
    if (result.status === "blocked") throw new Error(result.message);
  } finally {
    disposeIgnoredRpcResult(result);
  }
}

async function removeGithubWebhookSubscription(
  stream: GithubConnectionStream,
  input: { repoPath: string; subscriptionKey: string },
): Promise<void> {
  const result = await stream.removeCopySubscription({
    subscriptionKey: input.subscriptionKey,
    expectedReceiverPath: input.repoPath,
  });
  try {
    if (result.status === "blocked") throw new Error(result.message);
  } finally {
    disposeIgnoredRpcResult(result);
  }
}

type LinkRepoToGithubOptions = {
  repo?: {
    configureGithubLink(link: GithubRepoLink): Promise<GithubRepoLink>;
    getGithubLink(): GithubRepoLink | null | Promise<GithubRepoLink | null>;
    pushToGithub(input: { force?: boolean }): Promise<{ branch: string; commitOid: string }>;
  };
  skipInitialPush?: boolean;
};

export async function linkRepoToGithub(
  input: {
    connection: string;
    owner: string;
    projectId: string;
    repo: string;
    repoPath: string;
  },
  options: LinkRepoToGithubOptions = {},
): Promise<LinkGithubResult> {
  const repoPath = canonicalizeStreamPath(input.repoPath);
  // Trim at the boundary: a padded owner/repo would store a link (and a
  // GitHub coordinates) API calls never match — mirroring
  // would appear to work while webhook delivery silently didn't.
  const owner = input.owner.trim();
  const repo = input.repo.trim();
  if (owner === "" || repo === "") {
    throw new Error("linkGithub requires a non-empty owner and repo.");
  }
  const status = await getConnectionStatus({
    connection: input.connection,
    projectId: input.projectId,
    provider: "github",
  });
  if (!status.connected || status.externalId === null) {
    throw new Error(
      `GitHub connection "${input.connection}" is not connected; use itx.integrations.list() to see connections.`,
    );
  }

  const octokit = connectionOctokit({
    connection: input.connection,
    streamContext: { kind: "scope", scopePath: repoPath },
    projectId: input.projectId,
  });
  let created = false;
  let repositoryId: number;
  try {
    const response = await octokit.rest.repos.get({ owner, repo });
    repositoryId = githubRepositoryId(response.data.id, `${owner}/${repo}`);
  } catch (error) {
    if ((error as { status?: number }).status !== 404) {
      throw normalizeGithubError(error, input.connection);
    }
    // Create-on-link: private by default. Installation tokens can only create
    // repositories under an ORG the App is installed on (with Administration
    // write); under a user account GitHub answers 404 here — surface that as
    // the actionable "create it on GitHub first" case.
    try {
      const response = await octokit.rest.repos.createInOrg({
        name: repo,
        org: owner,
        private: true,
      });
      repositoryId = githubRepositoryId(response.data.id, `${owner}/${repo}`);
      created = true;
    } catch (createError) {
      // "name already exists" means the earlier 404 was an ACCESS miss, not a
      // missing repo: the App is installed with "selected repositories" and
      // this one is not selected. Say so — the generic message below claims
      // the repository "does not exist", the opposite of the truth.
      if (isGithubNameAlreadyExistsError(createError)) {
        throw new Error(
          `GitHub repository ${owner}/${repo} exists, but connection "${input.connection}" (App installation ${status.externalId}) has no access to it — the App is installed with "selected repositories" and this one is not selected. An org owner can grant access under Repository access at https://github.com/organizations/${owner}/settings/installations/${status.externalId}, then link again.`,
        );
      }
      throw new Error(
        `GitHub repository ${owner}/${repo} does not exist and could not be created via connection "${input.connection}" (App installations can only create org repositories, and need Administration write). Create it on GitHub and link again. Cause: ${normalizeGithubError(createError, input.connection).message}`,
      );
    }
  }

  const link: GithubRepoLink = {
    connection: input.connection,
    installationId: status.externalId,
    owner,
    repo,
    repositoryId,
  };
  const repoTarget = options.repo ?? repoDurableObjectStub(input.projectId, repoPath);
  const previous = await repoTarget.getGithubLink();
  const subscriptionKey = githubRepoSubscriptionKey(repoPath);

  // Re-linking through a DIFFERENT connection: the previous connection's
  // stream holds this repo's subscription (same key, other stream). Remove it
  // FIRST, before anything else changes — if the removal fails nothing has
  // moved and a retry starts clean, whereas removing it later would let a
  // failure strand a duplicate subscription that a retried linkGithub
  // (whose stored link already names the new connection) could never find
  // again. If a LATER step fails, the compensation below reinstalls this
  // exact subscription (the previous link carries everything needed to
  // rebuild it), so the old link never sits unrouted. Same connection needs
  // nothing: the subscription-configured below replaces by key.
  if (previous !== null && previous.connection !== input.connection) {
    await removeGithubWebhookSubscription(
      integrationStreamStub(
        input.projectId,
        integrationConnectionStreamPath("github", previous.connection),
      ),
      { repoPath, subscriptionKey },
    );
  }

  // The webhook lane: GitHub App webhooks already land as decoded JSON on the
  // connection stream (`/integrations/github/<connection>`); this stream
  // subscription copies the ones about the linked repository onto the repo's own
  // stream. The subscription is appended BEFORE the link is recorded — "linked"
  // must always imply "webhooks are copied" — and the link write is the commit
  // point: if it fails, the new rule is removed and the previous connection's
  // rule (removed above) is appended again.
  const connectionStream = integrationStreamStub(
    input.projectId,
    integrationConnectionStreamPath("github", input.connection),
  );
  try {
    await configureGithubWebhookSubscription(
      connectionStream,
      githubRepoSubscription({
        owner,
        repo,
        repositoryId,
        repoPath,
        subscriptionKey,
      }),
    );
    await repoTarget.configureGithubLink(link);
  } catch (error) {
    const compensations: string[] = [];
    // Remove the new rule (a no-op fold if the failure happened before it
    // committed) and restore the previous rule, including a
    // previous repository on this same connection, so the still-recorded old
    // link keeps its webhook lane. Both best-effort:
    // compensation failures are named in the surfaced error, and a re-run of
    // linkGithub repairs everything (subscriptions replace by key).
    try {
      await removeGithubWebhookSubscription(connectionStream, { repoPath, subscriptionKey });
    } catch (rollbackError) {
      compensations.push(
        `removing the new webhook subscription "${subscriptionKey}" from connection "${input.connection}" failed (${String(rollbackError)})`,
      );
    }
    if (previous !== null) {
      try {
        await configureGithubWebhookSubscription(
          integrationStreamStub(
            input.projectId,
            integrationConnectionStreamPath("github", previous.connection),
          ),
          githubRepoSubscription({
            owner: previous.owner,
            repo: previous.repo,
            repositoryId: previous.repositoryId,
            repoPath,
            subscriptionKey,
          }),
        );
      } catch (restoreError) {
        compensations.push(
          `restoring the previous webhook subscription on connection "${previous.connection}" failed (${String(restoreError)})`,
        );
      }
    }
    if (compensations.length === 0) throw error;
    console.error("github link compensation failed", { repoPath, subscriptionKey, compensations });
    throw new Error(
      `${String(error)} (additionally: ${compensations.join("; ")} — re-run linkGithub to repair; subscriptions replace by key)`,
    );
  }

  // Seed the mirror right away so "linked" means "visible on GitHub", not
  // "visible after the next commit". Failure is journaled, not fatal (a
  // pre-existing GitHub repo with unrelated history is the expected case —
  // the caller then picks syncFromGithub() or pushToGithub({ force: true })).
  let initialPush: LinkGithubResult["initialPush"];
  if (options.skipInitialPush === true) {
    initialPush = { ok: true, skipped: true };
  } else {
    try {
      const pushed = await repoTarget.pushToGithub({});
      initialPush = { commitOid: pushed.commitOid, ok: true };
    } catch (error) {
      initialPush = { error: String(error), ok: false };
    }
  }

  return { ...link, created, initialPush };
}

export async function unlinkRepoFromGithub(input: {
  projectId: string;
  repoPath: string;
}): Promise<{ unlinked: boolean }> {
  const repoPath = canonicalizeStreamPath(input.repoPath);
  const repoStub = repoDurableObjectStub(input.projectId, repoPath);
  const link = await repoStub.getGithubLink();
  if (link === null) return { unlinked: false };

  // Subscription removal first, link removal last — the same ordering as linkRepoToGithub:
  // the link is the commit point, so a failure anywhere leaves the link in
  // place and a retried unlinkGithub() can still find the connection and
  // finish the job (removing an already-removed subscription changes no state).
  await removeGithubWebhookSubscription(
    integrationStreamStub(
      input.projectId,
      integrationConnectionStreamPath("github", link.connection),
    ),
    { repoPath, subscriptionKey: githubRepoSubscriptionKey(repoPath) },
  );
  const removed = await repoStub.removeGithubLink();
  return { unlinked: removed !== null };
}

function repoDurableObjectStub(projectId: string, repoPath: string) {
  return itxEnv.REPO.getByName(DurableObjectNameCodec.stringify({ path: repoPath, projectId }));
}

function githubRepositoryId(value: unknown, fullName: string): number {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return value;
  throw new Error(`GitHub returned no valid repository id for ${fullName}.`);
}
