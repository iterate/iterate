// GitHub-router/agent test fixtures over the canonical in-memory stream
// harness (../streams/test-helpers.ts).

import { MemoryStreamNetwork as CanonicalMemoryStreamNetwork } from "../streams/test-helpers.ts";

export { MemoryStream } from "../streams/test-helpers.ts";

/**
 * The canonical network with its clock pinned to the epoch: the GitHub agent
 * suite pairs processor clocks like `now: () => 10` with ~epoch createdAt
 * stamps, so the 👀-ack freshness gate sees a small positive age.
 */
export class MemoryStreamNetwork extends CanonicalMemoryStreamNetwork {
  constructor() {
    super(() => 0);
  }
}

export const GITHUB_LINK = {
  connection: "install-789",
  installationId: "789",
  owner: "acme",
  repo: "widgets",
};

/** One captured GitHub webhook delivery, in the connection-stream envelope. */
export function webhookPayload(
  body: Record<string, unknown>,
  githubEvent = "pull_request",
): Record<string, unknown> {
  return {
    body,
    headers: { "content-type": "application/json", githubEvent },
    installationId: "789",
  };
}

export function pullRequestBody(input: {
  action?: string;
  body?: string;
  comment?: {
    authorAssociation?: string;
    body: string;
    id?: number;
    senderLogin?: string;
    senderType?: string;
  };
  draft?: boolean;
  headSha?: string;
  labels?: string[];
  number?: number;
  title?: string;
}): Record<string, unknown> {
  const number = input.number ?? 7;
  return {
    action: input.action ?? (input.comment === undefined ? "opened" : "created"),
    ...(input.comment === undefined
      ? {
          pull_request: {
            number,
            title: input.title ?? "Add widgets",
            author_association: "MEMBER",
            state: "open",
            draft: input.draft ?? false,
            head: {
              ref: "feature",
              sha: input.headSha ?? "head-abc",
              repo: { name: "widgets-fork", owner: { login: "author" } },
            },
            base: { ref: "main", sha: "base-abc" },
            body: input.body ?? "PR description",
            labels: (input.labels ?? []).map((name) => ({ name })),
            html_url: `https://github.com/acme/widgets/pull/${number}`,
            user: { login: "author" },
          },
        }
      : {
          issue: { number, title: input.title ?? "Add widgets", pull_request: { url: "x" } },
          comment: {
            author_association: input.comment.authorAssociation ?? "MEMBER",
            body: input.comment.body,
            html_url: "https://github.com/x",
            id: input.comment.id ?? 456,
          },
        }),
    sender: {
      login: input.comment?.senderLogin ?? "jonas",
      type: input.comment?.senderType ?? "User",
    },
    repository: { full_name: "acme/widgets" },
  };
}
