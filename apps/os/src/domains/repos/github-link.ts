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

/** The cross-post rule copying one repository's GitHub webhooks from a
 * connection stream onto the repo's own stream — built in one place so the
 * install and the re-link compensation (restore) can never drift. */
function githubCrossPostRuleEvent(input: {
  owner: string;
  repo: string;
  repoPath: string;
  ruleId: string;
}) {
  return {
    type: "events.iterate.com/stream/rule-configured",
    payload: {
      condition: `payload.body.repository.full_name = ${JSON.stringify(`${input.owner}/${input.repo}`)}`,
      eventTypes: [GITHUB_WEBHOOK_RECEIVED_EVENT_TYPE],
      path: input.repoPath,
      ruleId: input.ruleId,
      type: "cross-post",
    },
  };
}

export async function linkRepoToGithub(input: {
  connection: string;
  owner: string;
  projectId: string;
  repo: string;
  repoPath: string;
}): Promise<LinkGithubResult> {
  const repoPath = normalizePath(input.repoPath);
  // Trim at the boundary: a padded owner/repo would store a link (and a
  // full_name webhook condition) GitHub payloads never match — mirroring
  // would appear to work while webhook cross-post silently didn't.
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

  const octokit = connectionOctokit({ connection: input.connection, projectId: input.projectId });
  let created = false;
  try {
    await octokit.rest.repos.get({ owner, repo });
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
        name: repo,
        org: owner,
        private: true,
      });
      created = true;
    } catch (createError) {
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
  };
  const repoStub = repoDurableObjectStub(input.projectId, repoPath);
  const previous = await repoStub.getGithubLink();
  const ruleId = githubCrossPostRuleId(repoPath);

  // Re-linking through a DIFFERENT connection: the previous connection's
  // stream holds this repo's rule (same ruleId, other stream). Remove it
  // FIRST, before anything else changes — if the removal fails nothing has
  // moved and a retry starts clean, whereas removing it later would let a
  // failure strand a live duplicate rule that a retried linkGithub (whose
  // stored link already names the new connection) could never find again.
  // If a LATER step fails, the compensation below reinstalls this exact rule
  // (the previous link carries everything needed to rebuild it), so the old
  // link never sits ruleless. Same connection needs nothing: the
  // rule-configured below replaces by id.
  if (previous !== null && previous.connection !== input.connection) {
    await integrationStreamStub(
      input.projectId,
      integrationConnectionStreamPath("github", previous.connection),
    ).append({ type: "events.iterate.com/stream/rule-removed", payload: { ruleId } });
  }

  // The webhook lane: GitHub App webhooks already land verbatim on the
  // connection stream (`/integrations/github/<connection>`); this rule copies
  // the ones about the linked repository onto the repo's own stream. The rule
  // goes in BEFORE the link is recorded — "linked" must always imply
  // "webhooks route" — and the link write is the commit point: if it fails,
  // the just-installed rule is rolled back and the previous connection's rule
  // (removed above) is reinstalled.
  const connectionStream = integrationStreamStub(
    input.projectId,
    integrationConnectionStreamPath("github", input.connection),
  );
  try {
    await connectionStream.append(githubCrossPostRuleEvent({ owner, repo, repoPath, ruleId }));
    await repoStub.configureGithubLink(link);
  } catch (error) {
    const compensations: string[] = [];
    // Roll back the new rule (a no-op fold if the failure happened before it
    // committed) and restore the previous connection's rule so the still-
    // recorded old link keeps its webhook lane. Both best-effort: compensation
    // failures are named in the surfaced error, and a re-run of linkGithub
    // repairs everything (rules replace by id).
    try {
      await connectionStream.append({
        type: "events.iterate.com/stream/rule-removed",
        payload: { ruleId },
      });
    } catch (rollbackError) {
      compensations.push(
        `rolling back the webhook rule "${ruleId}" on connection "${input.connection}" failed (${String(rollbackError)})`,
      );
    }
    if (previous !== null && previous.connection !== input.connection) {
      try {
        await integrationStreamStub(
          input.projectId,
          integrationConnectionStreamPath("github", previous.connection),
        ).append(
          githubCrossPostRuleEvent({
            owner: previous.owner,
            repo: previous.repo,
            repoPath,
            ruleId,
          }),
        );
      } catch (restoreError) {
        compensations.push(
          `restoring the previous webhook rule on connection "${previous.connection}" failed (${String(restoreError)})`,
        );
      }
    }
    if (compensations.length === 0) throw error;
    console.error("github link compensation failed", { repoPath, ruleId, compensations });
    throw new Error(
      `${String(error)} (additionally: ${compensations.join("; ")} — re-run linkGithub to repair, rules replace by id)`,
    );
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
