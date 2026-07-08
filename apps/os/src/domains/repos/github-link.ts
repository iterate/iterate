// Linking a repo to a real GitHub repository — the itx-side flow behind
// `itx.repos.get(path).linkGithub(...)`.
//
// A link does three things, in order:
//   1. resolves the named GitHub connection (an App installation) and makes
//      sure the target repository exists — creating it, private, when the
//      installation has permission and it does not;
//   2. records the link on the Repo Durable Object (KV for the mirror-push hot
//      path + a `repo/github-link-configured` fact on the repo stream);
//   3. installs a cross-post rule on the connection stream so every GitHub
//      webhook about that repository is copied onto the repo's own stream —
//      the generic stream-rule primitive, not GitHub-special routing.
//
// Unlinking reverses 2 and 3. The mirror pushes themselves live on the Repo
// Durable Object (repo-durable-object.ts), serialized with commits.

import { itxEnv } from "../../env.ts";
import { DurableObjectNameCodec, normalizePath } from "../durable-object-names.ts";
import { getConnectionStatus } from "../integrations/connect-flows.ts";
import { connectionOctokit, normalizeGithubError } from "../integrations/github-api.ts";
import { integrationStreamStub } from "../integrations/integration-streams.ts";
import {
  GITHUB_WEBHOOK_RECEIVED_EVENT_TYPE,
  integrationConnectionStreamPath,
} from "../integrations/utils.ts";
import type { GithubRepoLink, LinkGithubResult } from "./types.ts";

/** The one rule id a repo's GitHub webhook cross-post rule lives under, so
 * re-linking replaces it and unlinking knows what to remove. */
function githubCrossPostRuleId(repoPath: string): string {
  return `github-repo:${repoPath}`;
}

export async function linkRepoToGithub(input: {
  connection: string;
  owner: string;
  projectId: string;
  repo: string;
  repoPath: string;
}): Promise<LinkGithubResult> {
  const repoPath = normalizePath(input.repoPath);
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

  const octokit = connectionOctokit({ connection: input.connection, projectId: input.projectId });
  let created = false;
  try {
    await octokit.rest.repos.get({ owner: input.owner, repo: input.repo });
  } catch (error) {
    if ((error as { status?: number }).status !== 404) {
      throw normalizeGithubError(error, input.connection);
    }
    // Create-on-link: private by default. Installation tokens can only create
    // repositories under an ORG the App is installed on (with Administration
    // write); under a user account GitHub answers 404 here — surface that as
    // the actionable "create it on GitHub first" case.
    try {
      await octokit.rest.repos.createInOrg({
        name: input.repo,
        org: input.owner,
        private: true,
      });
      created = true;
    } catch (createError) {
      throw new Error(
        `GitHub repository ${input.owner}/${input.repo} does not exist and could not be created via connection "${input.connection}" (App installations can only create org repositories, and need Administration write). Create it on GitHub and link again. Cause: ${normalizeGithubError(createError, input.connection).message}`,
      );
    }
  }

  const link: GithubRepoLink = {
    connection: input.connection,
    installationId: status.externalId,
    owner: input.owner,
    repo: input.repo,
  };
  const repoStub = repoDurableObjectStub(input.projectId, repoPath);
  const previous = await repoStub.getGithubLink();
  const ruleId = githubCrossPostRuleId(repoPath);

  // The webhook lane: GitHub App webhooks already land verbatim on the
  // connection stream (`/integrations/github/<connection>`); this rule copies
  // the ones about the linked repository onto the repo's own stream. The rule
  // goes in BEFORE the link is recorded — "linked" must always imply
  // "webhooks route" — and the link write is the commit point: if it fails,
  // the just-installed rule is rolled back.
  const connectionStream = integrationStreamStub(
    input.projectId,
    integrationConnectionStreamPath("github", input.connection),
  );
  await connectionStream.append({
    type: "events.iterate.com/stream/rule-configured",
    payload: {
      condition: `payload.body.repository.full_name = ${JSON.stringify(`${input.owner}/${input.repo}`)}`,
      eventTypes: [GITHUB_WEBHOOK_RECEIVED_EVENT_TYPE],
      path: repoPath,
      ruleId,
      type: "cross-post",
    },
  });
  try {
    await repoStub.configureGithubLink(link);
  } catch (error) {
    await connectionStream
      .append({ type: "events.iterate.com/stream/rule-removed", payload: { ruleId } })
      .catch(() => {});
    throw error;
  }

  // Re-linking through a DIFFERENT connection: the previous connection's
  // stream still holds this repo's rule (same ruleId, other stream) — remove
  // it so the old installation's webhooks stop cross-posting here. Same
  // connection needs nothing: the rule-configured above replaced it by id.
  if (previous !== null && previous.connection !== input.connection) {
    await integrationStreamStub(
      input.projectId,
      integrationConnectionStreamPath("github", previous.connection),
    ).append({ type: "events.iterate.com/stream/rule-removed", payload: { ruleId } });
  }

  // Seed the mirror right away so "linked" means "visible on GitHub", not
  // "visible after the next commit". Failure is journaled, not fatal (a
  // pre-existing GitHub repo with unrelated history is the expected case —
  // the caller then picks syncFromGithub() or pushToGithub({ force: true })).
  let initialPush: LinkGithubResult["initialPush"];
  try {
    const pushed = await repoStub.pushToGithub({});
    initialPush = { commitOid: pushed.commitOid, ok: true };
  } catch (error) {
    initialPush = { error: String(error), ok: false };
  }

  return { ...link, created, initialPush };
}

export async function unlinkRepoFromGithub(input: {
  projectId: string;
  repoPath: string;
}): Promise<{ unlinked: boolean }> {
  const repoPath = normalizePath(input.repoPath);
  const repoStub = repoDurableObjectStub(input.projectId, repoPath);
  const link = await repoStub.getGithubLink();
  if (link === null) return { unlinked: false };

  // Rule first, link last — mirroring linkRepoToGithub's ordering: the link
  // is the commit point, so a failure anywhere leaves the link in place and a
  // retried unlinkGithub() can still find the connection and finish the job
  // (removing an already-removed rule is a no-op fold).
  await integrationStreamStub(
    input.projectId,
    integrationConnectionStreamPath("github", link.connection),
  ).append({
    type: "events.iterate.com/stream/rule-removed",
    payload: { ruleId: githubCrossPostRuleId(repoPath) },
  });
  const removed = await repoStub.removeGithubLink();
  return { unlinked: removed !== null };
}

function repoDurableObjectStub(projectId: string, repoPath: string) {
  return itxEnv.REPO.getByName(DurableObjectNameCodec.stringify({ path: repoPath, projectId }));
}
