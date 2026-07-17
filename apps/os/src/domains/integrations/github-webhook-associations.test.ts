import { describe, expect, it } from "vitest";
import { githubWebhookAssociations } from "./github-webhook-associations.ts";

const REPOSITORY = {
  full_name: "acme/widgets",
  id: 101,
  node_id: "R_101",
};

describe("githubWebhookAssociations", () => {
  it.each([
    {
      name: "pull_request",
      payload: { pull_request: { number: 7 }, repository: REPOSITORY },
    },
    {
      name: "pull_request_review",
      payload: { pull_request: { number: 7 }, repository: REPOSITORY, review: {} },
    },
    {
      name: "pull_request_review_comment",
      payload: { comment: {}, pull_request: { number: 7 }, repository: REPOSITORY },
    },
    {
      name: "pull_request_review_thread",
      payload: { pull_request: { number: 7 }, repository: REPOSITORY, thread: {} },
    },
    {
      name: "issue_comment",
      payload: {
        comment: {},
        issue: { number: 7, pull_request: { url: "https://api.github.test/pulls/7" } },
        repository: REPOSITORY,
      },
    },
  ])("maps a $name subject to its repository ID and pull request number", ({ name, payload }) => {
    expect(githubWebhookAssociations({ name, payload })).toMatchObject({
      problems: [],
      pullRequests: [{ basis: "subject", number: 7, repositoryId: 101 }],
      repository: { fullName: "acme/widgets", id: 101, nodeId: "R_101" },
    });
  });

  it("does not associate a plain issue comment with a pull request", () => {
    const associations = githubWebhookAssociations({
      name: "issue_comment",
      payload: { comment: { body: "hello" }, issue: { number: 7 }, repository: REPOSITORY },
    });

    expect(associations.pullRequests).toEqual([]);
    expect(associations.problems).toEqual([]);
  });

  it.each(["check_run", "check_suite", "workflow_run"])(
    "uses each base repository ID for %s head associations",
    (name) => {
      const associations = githubWebhookAssociations({
        name,
        payload: {
          [name]: {
            pull_requests: [
              { base: { repo: { id: 101 } }, number: 7 },
              { base: { repo: { id: 202 } }, number: 8 },
            ],
          },
          // For fork CI this can be the head repository. It must not be used
          // as the PR's repository identity.
          repository: { full_name: "contributor/widgets", id: 303 },
        },
      });

      expect(associations.pullRequests).toEqual([
        { basis: "head", number: 7, repositoryId: 101 },
        { basis: "head", number: 8, repositoryId: 202 },
      ]);
    },
  );

  it("keeps the webhook actor separate from the mentioned content's author", () => {
    const associations = githubWebhookAssociations({
      name: "issue_comment",
      payload: {
        comment: {
          author_association: "MEMBER",
          body: "@Iterate please review with @alice; email me at person@example.com",
          user: { id: 44, login: "jonas", node_id: "U_44", type: "User" },
        },
        issue: { number: 7, pull_request: {} },
        repository: REPOSITORY,
        sender: { id: 99, login: "moderator", node_id: "U_99", type: "User" },
      },
    });

    expect(associations.actor).toEqual({
      id: 99,
      login: "moderator",
      nodeId: "U_99",
      type: "User",
    });
    expect(associations.contentAuthor).toEqual({
      authorAssociation: "MEMBER",
      id: 44,
      login: "jonas",
      nodeId: "U_44",
      type: "User",
    });
    expect(associations.mentionedUsers).toEqual(["iterate", "alice"]);
  });

  it.each(["@iterate_extra", `@iterate${"x".repeat(40)}`, "@iterate-", "@iterate--other"])(
    "does not truncate the invalid login in %s into an iterate mention",
    (body) => {
      const associations = githubWebhookAssociations({
        name: "issue_comment",
        payload: {
          comment: { body },
          issue: { number: 7, pull_request: {} },
          repository: REPOSITORY,
        },
      });

      expect(associations.mentionedUsers).not.toContain("iterate");
    },
  );

  it("keeps malformed native associations observable instead of guessing", () => {
    const associations = githubWebhookAssociations({
      name: "pull_request",
      payload: { pull_request: {}, repository: { full_name: "acme/widgets" } },
    });

    expect(associations.pullRequests).toEqual([]);
    expect(associations.problems).toEqual([
      { code: "repository-id-missing", path: "repository.id" },
      { code: "pull-request-number-missing", path: "pull_request.number" },
    ]);
  });

  it("leaves push webhooks unassociated with pull requests", () => {
    expect(
      githubWebhookAssociations({
        name: "push",
        payload: { ref: "refs/heads/main", repository: REPOSITORY },
      }),
    ).toMatchObject({ problems: [], pullRequests: [], repository: { id: 101 } });
  });
});
