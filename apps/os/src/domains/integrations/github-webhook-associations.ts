import type { EmitterWebhookEventName } from "@octokit/webhooks";
import { readNumber, readRecord, readString } from "./utils.ts";

/**
 * Extract the stable GitHub identities a project worker can route on while
 * preserving the complete webhook body separately. Event names are pinned to
 * Octokit's generated webhook union; payloads are still runtime-checked
 * because a signed delivery is external data, not a TypeScript value.
 *
 * GitHub's first-party payload reference is the reason subject events use the
 * top-level PR while check/workflow events use their native `pull_requests`:
 * https://docs.github.com/en/webhooks/webhook-events-and-payloads
 */
export function githubWebhookAssociations(input: {
  name: string | null;
  payload: Record<string, unknown>;
}): GithubWebhookAssociations {
  const problems: GithubWebhookAssociations["problems"] = [];
  const repository = readRepository(input.payload.repository);
  const pullRequests: GithubWebhookAssociations["pullRequests"] = [];
  const associationBasis =
    input.name === null ? undefined : pullRequestAssociationBasis.get(input.name);

  if (input.name !== null && associationBasis === "subject") {
    const subject = subjectPullRequest(input.name, input.payload);
    // An issue_comment may describe an ordinary issue; that is a valid event
    // with no pull-request association, not malformed PR routing data.
    if (subject !== null || input.name !== "issue_comment") {
      const number = positiveInteger(subject?.number);
      if (repository === undefined) {
        problems.push({ code: "repository-id-missing", path: "repository.id" });
      }
      if (number === undefined) {
        problems.push({ code: "pull-request-number-missing", path: subjectPath(input.name) });
      }
      if (repository !== undefined && number !== undefined) {
        pullRequests.push({ basis: "subject", number, repositoryId: repository.id });
      }
    }
  }

  if (input.name !== null && associationBasis === "head") {
    const container = readRecord(input.payload[input.name]);
    const values = Array.isArray(container?.pull_requests) ? container.pull_requests : null;
    if (values === null) {
      problems.push({
        code: "pull-request-associations-missing",
        path: `${input.name}.pull_requests`,
      });
    } else {
      values.forEach((value, index) => {
        const pullRequest = readRecord(value);
        const number = positiveInteger(pullRequest?.number);
        const baseRepository = readRecord(readRecord(pullRequest?.base)?.repo);
        const repositoryId = positiveInteger(baseRepository?.id);
        if (number === undefined || repositoryId === undefined) {
          problems.push({
            code: "pull-request-association-malformed",
            path: `${input.name}.pull_requests[${index}]`,
          });
          return;
        }
        pullRequests.push({ basis: "head", number, repositoryId });
      });
    }
  }

  const actor = readGithubUser(input.payload.sender);
  const activity = activityAuthor(input.name, input.payload);
  const contentAuthor = readGithubUserAssociation(activity);

  return {
    actor,
    contentAuthor,
    mentionedUsers: mentionedUsers(input.name, input.payload),
    problems,
    pullRequests: deduplicatePullRequests(pullRequests),
    repository,
  };
}

type GithubUserAssociation = {
  authorAssociation?: string;
  id?: number;
  login?: string;
  nodeId?: string;
  type?: string;
};

type GithubWebhookAssociations = {
  actor?: {
    id?: number;
    login?: string;
    nodeId?: string;
    type?: string;
  };
  contentAuthor?: GithubUserAssociation;
  mentionedUsers: string[];
  problems: Array<{ code: string; path: string }>;
  pullRequests: Array<{
    basis: "head" | "subject";
    number: number;
    repositoryId: number;
  }>;
  repository?: {
    fullName?: string;
    id: number;
    nodeId?: string;
  };
};

const pullRequestAssociationBasis = new Map<string, "head" | "subject">([
  ["issue_comment", "subject"],
  ["pull_request", "subject"],
  ["pull_request_review", "subject"],
  ["pull_request_review_comment", "subject"],
  ["pull_request_review_thread", "subject"],
  ["check_run", "head"],
  ["check_suite", "head"],
  ["workflow_run", "head"],
] satisfies Array<[EmitterWebhookEventName, "head" | "subject"]>);

function readGithubUser(value: unknown): GithubWebhookAssociations["actor"] {
  const user = readRecord(value);
  const id = positiveInteger(user?.id);
  const login = nonEmptyString(user?.login);
  const nodeId = nonEmptyString(user?.node_id);
  const type = nonEmptyString(user?.type);
  return id === undefined && login === undefined && nodeId === undefined && type === undefined
    ? undefined
    : {
        ...(id === undefined ? {} : { id }),
        ...(login === undefined ? {} : { login }),
        ...(nodeId === undefined ? {} : { nodeId }),
        ...(type === undefined ? {} : { type }),
      };
}

function readGithubUserAssociation(value: unknown): GithubUserAssociation | undefined {
  const activity = readRecord(value);
  const user = readGithubUser(activity?.user);
  const authorAssociation = nonEmptyString(activity?.author_association);
  return user === undefined && authorAssociation === undefined
    ? undefined
    : { ...user, ...(authorAssociation === undefined ? {} : { authorAssociation }) };
}

function readRepository(value: unknown): GithubWebhookAssociations["repository"] {
  const repository = readRecord(value);
  const id = positiveInteger(repository?.id);
  if (id === undefined) return undefined;
  const fullName = nonEmptyString(repository?.full_name);
  const nodeId = nonEmptyString(repository?.node_id);
  return {
    id,
    ...(fullName === undefined ? {} : { fullName }),
    ...(nodeId === undefined ? {} : { nodeId }),
  };
}

function subjectPullRequest(
  name: string,
  payload: Record<string, unknown>,
): Record<string, unknown> | null {
  if (name === "issue_comment") {
    const issue = readRecord(payload.issue);
    return issue?.pull_request === undefined || issue.pull_request === null ? null : issue;
  }
  return readRecord(payload.pull_request);
}

function subjectPath(name: string): string {
  return name === "issue_comment" ? "issue.number" : "pull_request.number";
}

function activityAuthor(
  name: string | null,
  payload: Record<string, unknown>,
): Record<string, unknown> | null {
  switch (name) {
    case "issue_comment":
    case "pull_request_review_comment":
      return readRecord(payload.comment);
    case "pull_request_review":
      return readRecord(payload.review);
    case "pull_request":
      return readRecord(payload.pull_request);
    default:
      return null;
  }
}

function mentionedUsers(name: string | null, payload: Record<string, unknown>): string[] {
  const author = activityAuthor(name, payload);
  const texts =
    name === "pull_request"
      ? [readString(author?.title), readString(author?.body)]
      : [readString(author?.body)];
  const mentions = new Set<string>();
  for (const text of texts) {
    if (text === undefined) continue;
    // GitHub logins are 1–39 alphanumerics/single hyphens, with no leading or
    // trailing hyphen. The right boundary prevents `@iterate_extra` or an
    // overlong login from being truncated into a trusted `@iterate` mention.
    for (const match of text.matchAll(
      /(^|[^\w@])@([a-z\d](?:[a-z\d]|-(?=[a-z\d])){0,38})(?![a-z\d_-])/gi,
    )) {
      const login = match[2]?.toLowerCase();
      if (login !== undefined) mentions.add(login);
    }
  }
  return [...mentions];
}

function deduplicatePullRequests(
  pullRequests: GithubWebhookAssociations["pullRequests"],
): GithubWebhookAssociations["pullRequests"] {
  const byIdentity = new Map<string, GithubWebhookAssociations["pullRequests"][number]>();
  for (const pullRequest of pullRequests) {
    const key = `${pullRequest.repositoryId}:${pullRequest.number}`;
    const existing = byIdentity.get(key);
    if (existing === undefined || pullRequest.basis === "subject") {
      byIdentity.set(key, pullRequest);
    }
  }
  return [...byIdentity.values()];
}

function positiveInteger(value: unknown): number | undefined {
  const number = readNumber(value);
  return number !== undefined && Number.isSafeInteger(number) && number > 0 ? number : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  const string = readString(value);
  return string === undefined || string.length === 0 ? undefined : string;
}
