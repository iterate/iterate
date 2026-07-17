import type { EmitterWebhookEvent } from "@octokit/webhooks";

type RelevantGithubWebhook = {
  [Name in RelevantGithubWebhookName]: EmitterWebhookEvent<Name>;
}[RelevantGithubWebhookName];

type RelevantGithubWebhookName =
  | "issue_comment"
  | "pull_request"
  | "pull_request_review"
  | "pull_request_review_comment"
  | "pull_request_review_thread";

type MentionableGithubContent =
  | EmitterWebhookEvent<"issue_comment">["payload"]["comment"]
  | EmitterWebhookEvent<"pull_request_review">["payload"]["review"]
  | EmitterWebhookEvent<"pull_request_review_comment">["payload"]["comment"];

/**
 * Add only the GitHub identities userspace needs to route a raw webhook.
 * Octokit's generated payload types remain the schema; the complete decoded
 * vendor payload is stored separately on the event.
 */
export function githubWebhookAssociations(input: {
  id: string;
  name: string;
  payload: Record<string, unknown>;
}) {
  switch (input.name) {
    case "issue_comment":
    case "pull_request":
    case "pull_request_review":
    case "pull_request_review_comment":
    case "pull_request_review_thread":
      break;
    default:
      return {};
  }

  // JSON parsing cannot preserve a generated TypeScript type. The signature
  // was verified before this function and the header was narrowed above, so
  // this is the same unavoidable boundary cast used by Octokit's own
  // verifyAndReceive implementation:
  // https://github.com/octokit/webhooks.js/blob/v14.2.0/src/verify-and-receive.ts#L34-L47
  const event = input as RelevantGithubWebhook;
  const nativeRepository = event.payload.repository;
  const repositoryOwner = nativeRepository?.owner?.login;
  if (
    nativeRepository === undefined ||
    repositoryOwner === undefined ||
    !Number.isSafeInteger(nativeRepository.id) ||
    nativeRepository.id < 1 ||
    nativeRepository.name.length === 0
  )
    return {};
  const repository = {
    id: nativeRepository.id,
    owner: repositoryOwner,
    repo: nativeRepository.name,
  };
  let content: MentionableGithubContent | undefined;
  let pullRequestNumber: number | undefined;

  switch (event.name) {
    case "issue_comment":
      if (event.payload.issue.pull_request !== undefined) {
        pullRequestNumber = event.payload.issue.number;
        content = event.payload.comment;
      }
      break;
    case "pull_request":
    case "pull_request_review_thread":
      pullRequestNumber = event.payload.pull_request.number;
      break;
    case "pull_request_review":
      pullRequestNumber = event.payload.pull_request.number;
      content = event.payload.review;
      break;
    case "pull_request_review_comment":
      pullRequestNumber = event.payload.pull_request.number;
      content = event.payload.comment;
      break;
  }

  const author =
    content?.user === null || content?.user === undefined
      ? undefined
      : {
          association: content.author_association,
          login: content.user.login,
          type: content.user.type,
        };
  const mentionedUsers = new Set<string>();
  for (const match of (content?.body ?? "").matchAll(
    /(^|[^\w@])@([a-z\d](?:[a-z\d]|-(?=[a-z\d])){0,38})(?![a-z\d_-])/gi,
  )) {
    if (match[2] !== undefined) mentionedUsers.add(match[2].toLowerCase());
  }

  return {
    ...(author === undefined ? {} : { author }),
    mentionedUsers: [...mentionedUsers],
    ...(pullRequestNumber === undefined ? {} : { pullRequest: { number: pullRequestNumber } }),
    repository,
  };
}
